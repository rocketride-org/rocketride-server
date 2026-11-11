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

#include "test.h"

using namespace engine::store::pipeline;

namespace validate_pipeline_test {

// The errors validate reports, each as "<id>: <message>"
std::vector<Text> reported(json::Value root);

// A node of the caller's own, of class text, with the lanes given
json::Value fixture(const char *name, json::Value lanes);

}  // namespace validate_pipeline_test

using namespace validate_pipeline_test;

// The pipeline-wide checks against the services: a provider is a service, a
// control entry sits on the node being called, and a wire's lane is one its
// two nodes declare. Only validate runs them; a run checks the shape alone.
TEST_CASE("store::validatePipeline") {
    // A pipeline the canvas could draw: webhook -> parse -> extract_data, which
    // calls llm_openai -> chunker -> response
    json::Value root = R"({
        "pipeline": {
            "source": "webhook_1",
            "version": 1,
            "components": [
                {"id": "webhook_1", "provider": "webhook", "config": {}},
                {"id": "parse_1", "provider": "parse", "config": {},
                 "input": [{"lane": "tags", "from": "webhook_1"}]},
                {"id": "extract_data_1", "provider": "extract_data",
                 "config": {},
                 "input": [{"lane": "text", "from": "parse_1"}]},
                {"id": "llm_openai_1", "provider": "llm_openai", "config": {},
                 "control": [{"classType": "llm", "from": "extract_data_1"}]},
                {"id": "chunker_1", "provider": "chunker", "config": {},
                 "input": [{"lane": "documents", "from": "extract_data_1"}]},
                {"id": "response_1", "provider": "response", "config": {},
                 "input": [{"lane": "answers", "from": "extract_data_1"},
                           {"lane": "documents", "from": "chunker_1"}]}
            ]
        }
    })"_json;
    auto &components = root["pipeline"]["components"];
    auto &parse = components[1];
    auto &extract = components[2];
    auto &llm = components[3];
    auto &chunker = components[4];

    // Every broken pipeline below is one a run still starts: the run's own
    // check, PipelineConfig::validate, is unchanged
    const auto runAccepts = [&] {
        PipelineConfig config(root);
        REQUIRE_NO_ERROR(config.validate());
    };

    SECTION("valid") { REQUIRE(reported(root).empty()); }

    // edit-03: a typo in the provider
    SECTION("provider:unknown") {
        llm["provider"] = "llm_opnai";

        runAccepts();
        REQUIRE(reported(root) ==
                std::vector<Text>{
                    "llm_openai_1: Component llm_openai_1 names provider "
                    "llm_opnai, which is not a service on this engine; use a "
                    "provider from the service catalog"});
    }

    // build-04: the control entry on the node that calls the LLM, not on the
    // LLM, so the run fails with "No control listeners registered for llm"
    SECTION("control:backwards") {
        llm.removeMember("control");
        extract["control"] =
            R"([{"classType": "llm", "from": "llm_openai_1"}])"_json;

        runAccepts();
        REQUIRE(reported(root) ==
                std::vector<Text>{
                    "extract_data_1: Component extract_data_1 control from "
                    "llm_openai_1 has classType llm, which is not a class of "
                    "extract_data (text); a control entry goes on the node "
                    "being called, with from naming the node that calls it"});
    }

    // build-03: the chunker fed documents by a node that never writes them
    SECTION("lane:not produced") {
        chunker["input"][0]["from"] = "parse_1";

        runAccepts();
        REQUIRE(reported(root) ==
                std::vector<Text>{
                    "chunker_1: Component chunker_1 input from parse_1 is on "
                    "lane documents, which parse does not produce; it "
                    "produces text, table, image, video, audio"});
    }

    // edit-03's other fault: a lane the node never reads
    SECTION("lane:not taken") {
        llm["input"] = R"([{"lane": "text", "from": "parse_1"}])"_json;

        runAccepts();
        REQUIRE(reported(root) ==
                std::vector<Text>{
                    "llm_openai_1: Component llm_openai_1 input from parse_1 "
                    "is on lane text, which llm_openai does not take; it "
                    "takes questions"});
    }

    // All the faults come back together, not one per call
    SECTION("all at once") {
        llm["provider"] = "llm_opnai";
        chunker["input"][0]["from"] = "parse_1";
        llm.removeMember("control");
        extract["control"] =
            R"([{"classType": "llm", "from": "llm_openai_1"}])"_json;

        runAccepts();
        auto errors = reported(root);
        REQUIRE(errors.size() == 3);
        CHECK(errors[0].startsWith("llm_openai_1: "));
        CHECK(errors[1].startsWith("extract_data_1: "));
        CHECK(errors[2].startsWith("chunker_1: "));
    }

    // A pipeline the structure check refuses is not checked further
    SECTION("shape first") {
        llm["provider"] = "llm_opnai";
        parse["input"][0]["lane"] = "unknown_lane";

        auto errors = reported(root);
        REQUIRE(errors.size() == 1);
        CHECK(errors[0].contains("input has unknown lane unknown_lane"));
    }

    // Lanes and classes come from the definitions a call brings with it too
    SECTION("custom nodes") {
        auto scope = IServices::withCustomServices([] {
            json::Value list = json::arrayValue;
            list.append(fixture("fx_forward", R"({"*": ["*"]})"_json));
            list.append(fixture("fx_sink", R"({"*": []})"_json));
            list.append(fixture("fx_tool", R"({})"_json));
            list.append(fixture("fx_text", R"({"text": ["text"]})"_json));
            return list;
        }());
        REQUIRE_NO_ERROR(scope);

        const auto add = [&](const char *id, const char *provider,
                             const char *lane, const char *from) {
            json::Value component;
            component["id"] = id;
            component["provider"] = provider;
            component["config"] = json::Value(json::objectValue);
            json::Value input;
            input["lane"] = lane;
            input["from"] = from;
            component["input"].append(input);
            components.append(component);
        };

        // A "*" lane takes and forwards any lane (#2667)
        SECTION("any lane") {
            add("forward_1", "fx_forward", "table", "parse_1");
            add("text_1", "fx_text", "text", "forward_1");
            add("sink_1", "fx_sink", "video", "parse_1");

            REQUIRE(reported(root).empty());
        }

        // A node with no lanes, such as a tool, is not checked for what it
        // takes; what it produces still is
        SECTION("no lanes") {
            add("tool_1", "fx_tool", "text", "parse_1");
            add("text_1", "fx_text", "text", "tool_1");

            runAccepts();
            REQUIRE(reported(root) ==
                    std::vector<Text>{
                        "text_1: Component text_1 input from tool_1 is on "
                        "lane text, which fx_tool does not produce; it "
                        "produces no lanes"});
        }
    }
}

namespace validate_pipeline_test {

std::vector<Text> reported(json::Value root) {
    auto result = validatePipelineOrComponent(_mv(root));
    REQUIRE_NO_ERROR(result);

    std::vector<Text> errors;
    const json::Value &validated = *result;
    if (!validated.isMember("errors")) return errors;
    for (const auto &error : validated["errors"])
        errors.push_back(
            _ts(error["id"].asString(), ": ", error["message"].asString()));
    return errors;
}

json::Value fixture(const char *name, json::Value lanes) {
    json::Value def = R"({
        "register": "filter", "node": "python", "classType": ["text"],
        "capabilities": [], "fields": {}, "shape": [],
        "icon": "data:image/svg+xml;base64,PHN2Zy8+"
    })"_json;
    def["title"] = name;
    def["protocol"] = _ts(name, "://");
    def["path"] = _ts("nodes.", name);
    def["prefix"] = name;
    def["lanes"] = _mv(lanes);
    return def;
}

}  // namespace validate_pipeline_test
