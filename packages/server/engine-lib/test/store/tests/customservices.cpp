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

#include <pybind11/embed.h>

#include "../store.h"

namespace py = pybind11;

namespace {
// A custom service as a caller passes it: JSON only, its icon inline
json::Value customNode(const char *name) {
    json::Value def = R"({
        "register": "filter", "node": "python", "classType": ["text"],
        "capabilities": [], "lanes": {"text": ["text"]}, "fields": {},
        "shape": [], "icon": "data:image/svg+xml;base64,PHN2Zy8+"
    })"_json;
    def["title"] = name;
    def["protocol"] = _ts(name, "://");
    def["path"] = _ts("nodes.", name);
    def["prefix"] = name;
    return def;
}

json::Value customList(std::initializer_list<json::Value> defs) {
    json::Value list = json::arrayValue;
    for (auto &def : defs) list.append(def);
    return list;
}

// Any service the start-up scan registered
Text registeredType() {
    auto schemas = IServices::getServiceSchemas();
    REQUIRE_NO_ERROR(schemas);
    return (*schemas)["services"].getMemberNames().front();
}
}  // namespace

//-----------------------------------------------------------------------------
// Custom services are seen by the lookups of the call they came with, and the
// registry is the same before and after
//-----------------------------------------------------------------------------
TEST_CASE("store::custom services are seen only by their call") {
    REQUIRE_FALSE(IServices::getServiceDefinition("custom_a"));

    bool ran = false;
    REQUIRE_NO_ERROR(IServices::withCustomServices(
        customList({customNode("custom_a")}), [&]() -> Error {
            // CHECK, not REQUIRE: a throw cannot leave this noexcept call
            ran = true;
            auto def = IServices::getServiceDefinition("custom_a");
            if (!def) return def.ccode();
            CHECK((*def)->isResolved);
            CHECK((*def)->title == "custom_a");

            auto schemas = IServices::getServiceSchemas();
            if (!schemas) return schemas.ccode();
            CHECK((*schemas)["services"].isMember("custom_a"));
            CHECK((*schemas)["services"]["custom_a"]["icon"].asString() ==
                  "data:image/svg+xml;base64,PHN2Zy8+");
            return {};
        }));
    REQUIRE(ran);

    REQUIRE_FALSE(IServices::getServiceDefinition("custom_a"));
    auto schemas = IServices::getServiceSchemas();
    REQUIRE_NO_ERROR(schemas);
    REQUIRE_FALSE((*schemas)["services"].isMember("custom_a"));

    // Nothing is registered for it either
    const auto names = Factory::getFactories("iFilterGlobal");
    REQUIRE(std::find(names.begin(), names.end(), iTextView{"custom_a"}) ==
            names.end());
}

TEST_CASE("store::custom services nest and restore the outer call's") {
    REQUIRE_NO_ERROR(IServices::withCustomServices(
        customList({customNode("custom_outer")}), [&]() -> Error {
            CHECK_FALSE(IServices::withCustomServices(
                customList({customNode("custom_inner")}), [&]() -> Error {
                    CHECK(IServices::getServiceDefinition("custom_inner"));
                    return {};
                }));
            CHECK(IServices::getServiceDefinition("custom_outer"));
            CHECK_FALSE(IServices::getServiceDefinition("custom_inner"));
            return {};
        }));
}

TEST_CASE("store::custom services that cannot be used are refused") {
    auto shadow = customNode("custom_b");
    shadow["protocol"] = _ts(registeredType(), "://");

    auto iconFile = customNode("custom_c");
    iconFile["icon"] = "icon.svg";

    auto noProtocol = customNode("custom_d");
    noProtocol.removeMember("protocol");

    auto badCap = customNode("custom_e");
    badCap["capabilities"].append("nonsense");

    auto cppNoLibrary = customNode("custom_f");
    cppNoLibrary["node"] = "cpp";
    cppNoLibrary["path"] = "";

    const json::Value refused[] = {
        customList({shadow}),
        customList({customNode("custom_g"), customNode("custom_g")}),
        customList({iconFile}),
        customList({noProtocol}),
        customList({badCap}),
        customList({cppNoLibrary}),
        customList({"custom_h"}),
        customNode("custom_i"),
    };
    for (const auto &custom : refused) {
        bool ran = false;
        REQUIRE(IServices::withCustomServices(custom, [&]() -> Error {
            ran = true;
            return {};
        }));
        REQUIRE_FALSE(ran);
    }

    // A registered type keeps its own definition
    REQUIRE(IServices::getServiceDefinition(registeredType()));
}

//-----------------------------------------------------------------------------
// The Python surface: the catalogue and validation take the same list
//-----------------------------------------------------------------------------
TEST_CASE("store::custom services through engLib") {
    const auto python = localfcn()->Error {
        py::module_::import("__main__").attr("custom") =
            engine::python::pyjson::jsonToDict(customNode("custom_py"));
        py::exec(R"(
import engLib, json
assert 'custom_py' in engLib.getServiceDefinitions(custom=[custom])['services']
assert 'custom_py' not in engLib.getServiceDefinitions()['services']

shadow = dict(custom, protocol=next(iter(engLib.getServiceDefinitions()['services'])) + '://')
try:
    engLib.getServiceDefinitions(custom=[shadow])
    raise AssertionError('a custom service that shadows a registered one was accepted')
except AssertionError:
    raise
except Exception:
    pass

# Validation encrypts what the definition marks secure: a user's node secret
# stays in the clear unless validation sees the custom definition
secret = dict(custom, fields={'custom_py.apikey': {'type': 'string', 'title': 'Key', 'secure': True}},
              shape=[{'section': 'Pipe', 'title': 'Custom', 'properties': ['custom_py.apikey']}])
def pipeline():
    return {'pipeline': {'source': 'c1', 'version': 1, 'components': [
        {'id': 'c1', 'provider': 'custom_py', 'config': {'parameters': {'apikey': 's3cret-key'}}}]}}
assert 's3cret-key' in json.dumps(engLib.validatePipeline(pipeline()))
validated = json.dumps(engLib.validatePipeline(pipeline(), custom=[secret]))
assert 's3cret-key' not in validated and 'secureParameters' in validated, validated

# The stack-only build EaaS runs at launch resolves the node the same way; the
# source is not built there, so the custom node is a filter behind one
source = {'pipeline': {'source': 's1', 'version': 1, 'components': [
    {'id': 's1', 'provider': 'webhook', 'config': {}},
    {'id': 'c1', 'provider': 'custom_py', 'config': {}, 'input': [{'lane': 'text', 'from': 's1'}]}]}}
try:
    engLib.ILoader.getPipeStack(source)
    raise AssertionError('a pipeline naming an unknown node was built')
except AssertionError:
    raise
except Exception as e:
    assert 'custom_py' in str(e), e
assert engLib.ILoader.getPipeStack(source, custom=[custom]) is not None
)");
        return {};
    };
    REQUIRE_NO_ERROR(callPython(python));
}
