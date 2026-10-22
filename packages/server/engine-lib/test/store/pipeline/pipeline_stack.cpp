// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================


#include "../store.h"

//-----------------------------------------------------------------------------
// generatePipelineStack end to end: a pipeline's JSON in, the connection table
// out. Stack only, so no filter is instantiated; the services are the
// test-only ones in services/.
//-----------------------------------------------------------------------------
namespace {

// Builds a pipeline's stack the way the loader does
auto stackOf(const char *components) {
    static const bool loaded = [] {
        return !IServices::loadDirectory(file::Path(__FILE__).parent() / "services");
    }();
    REQUIRE(loaded);

    auto task = R"({
        "type": "pipeline",
        "nodeId": "d24eca5f-0000-4029-aa90-75fd61fd856e",
        "taskId": "6a1e2d4c-0000-4c55-9a3e-0b6f2d7c8e91",
        "config": {
            "service": {"key": "null://Null", "name": "Null endpoint", "type": "null",
                        "mode": "target", "parameters": {}}
        }
    })"_json;
    auto pipeline = json::parse(_ts(R"({"source": "src", "version": 1, "components": )", components, "}"));
    REQUIRE_NO_ERROR(pipeline);
    task["config"]["service"]["pipeline"] = *pipeline;
    return IServiceEndpoint::getTargetEndpoint({.jobConfig = task,
                                                .taskConfig = task["config"],
                                                .serviceConfig = task["config"]["service"],
                                                .openMode = OPEN_MODE::PIPELINE,
                                                .stackOnly = true});
}

// The source component every pipeline here starts from
const char *SOURCE = R"({"id": "src", "provider": "fx_source", "config": {"mode": "Source"}})";

// A component wired to its inputs, each "lane from"
std::string component(const char *id, const char *provider,
                 std::initializer_list<std::pair<const char *, const char *>> inputs = {},
                 const char *controlledBy = nullptr) {
    std::string text = _ts(R"({"id": ")", id, R"(", "provider": ")", provider, R"(", "config": {})");
    if (inputs.size()) {
        text += R"(, "input": [)";
        bool first = true;
        for (const auto &[lane, from] : inputs) {
            text += _ts(first ? "" : ", ", R"({"lane": ")", lane, R"(", "from": ")", from, R"("})");
            first = false;
        }
        text += "]";
    }
    if (controlledBy)
        text += _ts(R"(, "control": [{"classType": "tool", "from": ")", controlledBy, R"("}])");
    return text + "}";
}

std::string components(std::initializer_list<std::string> list) {
    std::string text = std::string("[") + SOURCE;
    for (const auto &each : list) text += ", " + each;
    return text + "]";
}

template <typename Endpoint>
std::string idOf(const Endpoint &endpoint, int index) {
    return index == -1 ? "src" : std::string(endpoint->pipeStack[index].id);
}

// The connection table as "from>to:lane"
template <typename Endpoint>
std::set<std::string> wires(const Endpoint &endpoint) {
    std::set<std::string> result;
    for (const auto &[from, to, lane] : endpoint->connections)
        result.insert(idOf(endpoint, from) + ">" + idOf(endpoint, to) + ":" + lane);
    return result;
}

}  // namespace

TEST_CASE("store::generatePipelineStack any lane") {
    SECTION("a \"*\" node is bound on what the nodes after it ask for") {
        auto endpoint = stackOf(components({component("any", "fx_any", {{"*", "src"}}),
                                          component("out", "fx_sink", {{"text", "any"}})}).c_str());
        REQUIRE_NO_ERROR(endpoint);
        REQUIRE(wires(*endpoint) == std::set<std::string>{"src>any:text", "any>out:text"});
    }

    SECTION("a chain of \"*\" nodes settles, whatever order it is declared in") {
        auto endpoint = stackOf(components({component("out", "fx_sink", {{"text", "b"}}),
                                          component("b", "fx_any", {{"*", "a"}}),
                                          component("a", "fx_any", {{"*", "src"}})}).c_str());
        REQUIRE_NO_ERROR(endpoint);
        REQUIRE(wires(*endpoint) ==
                std::set<std::string>{"src>a:text", "a>b:text", "b>out:text"});
    }

    SECTION("a node that forwards nothing is bound on everything its source declares") {
        auto endpoint = stackOf(components({component("all", "fx_any_sink", {{"*", "src"}})}).c_str());
        REQUIRE_NO_ERROR(endpoint);
        REQUIRE(wires(*endpoint) == std::set<std::string>{"src>all:tags", "src>all:text"});
    }

    SECTION("a \"*\" node with nothing after it is rejected") {
        REQUIRE_ERROR(stackOf(components({component("any", "fx_any", {{"*", "src"}})}).c_str()),
                      Ec::InvalidParam, "nothing is wired after it");
    }

    SECTION("a lane nothing before the \"*\" node produces is rejected") {
        REQUIRE_ERROR(stackOf(components({component("any", "fx_any", {{"*", "src"}}),
                                        component("out", "fx_sink", {{"documents", "any"}})})
                                  .c_str()),
                      Ec::InvalidParam, "is asked for documents");
    }

    SECTION("a \"*\" wire whose source produces none of the asked lanes is rejected") {
        REQUIRE_ERROR(stackOf(components({component("split", "fx_split", {{"tags", "src"}}),
                                        component("any", "fx_any", {{"*", "src"}, {"*", "split"}}),
                                        component("out", "fx_sink", {{"text", "any"}})})
                                  .c_str()),
                      Ec::InvalidParam, "produces none of the lanes asked of it");
    }
}

TEST_CASE("store::validateLanesShape") {
    auto shape = [](const char *lanes) {
        return IServices::validateLanesShape(*json::parse(lanes), "fx");
    };

    SECTION("the two any-lane shapes and plain named lanes are accepted") {
        REQUIRE_NO_ERROR(shape(R"({"*": ["*"]})"));
        REQUIRE_NO_ERROR(shape(R"({"*": []})"));
        REQUIRE_NO_ERROR(shape(R"({"_source": ["text"], "text": ["documents"]})"));
    }

    SECTION("any lane in, named lanes out is rejected") {
        REQUIRE_ERROR(shape(R"({"*": ["text"]})"), Ec::InvalidParam, "must be [\"*\"]");
        REQUIRE_ERROR(shape(R"({"*": ["*", "text"]})"), Ec::InvalidParam, "must be [\"*\"]");
        REQUIRE_ERROR(shape(R"({"*": "*"})"), Ec::InvalidParam, "must be [\"*\"]");
    }

    SECTION("\"*\" beside a named lane is rejected") {
        REQUIRE_ERROR(shape(R"({"*": ["*"], "text": []})"), Ec::InvalidParam, "beside the named lane");
    }

    SECTION("\"*\" as the output of a named lane is rejected") {
        REQUIRE_ERROR(shape(R"({"text": ["*"]})"), Ec::InvalidParam, "outputs \"*\" on the lane");
        REQUIRE_ERROR(shape(R"({"_source": ["*"]})"), Ec::InvalidParam, "outputs \"*\" on the lane");
    }
}
