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

#include "test.h"

namespace py = pybind11;

namespace {
json::Value customNode(const char *name);
json::Value customList(std::initializer_list<json::Value> defs);
Text registeredType();
}  // namespace

TEST_CASE("store::Services") {
    auto _res = IServices::getServiceSchemas();
    if (!_res) {
        ASSERT_MSG(true, "getServiceSchemas Failed");
    }

    auto schema{_mv(*_res)};

    SECTION("version") {
        REQUIRE(schema.isMember("version"));
        REQUIRE(schema["version"].isInt());
        REQUIRE(schema["version"] == IServices::VERSION);
    }

    SECTION("services") {
        REQUIRE(schema.isMember("services"));
        REQUIRE(schema["services"].isObject());
    }

    SECTION("every loaded service carries params and paths") {
        for (const auto &name : schema["services"].getMemberNames()) {
            const auto &service = schema["services"][name];
            REQUIRE(service["params"].isArray());
            for (const auto &property : service["properties"]) {
                REQUIRE_FALSE(property.isMember("param"));
                if (!property.isMember("properties") ||
                    property.isMember("enum"))
                    REQUIRE(property["path"].isString());
            }
        }
    }
}

//-----------------------------------------------------------------------------
// Fixture helpers: a service definition is resolved through the same
// IServices::buildSchema the loader uses, without being loaded
//-----------------------------------------------------------------------------
namespace {

// Resolves a fixture service definition, returning the whole definition
// (schema plus the secure parameter registrations)
ErrorOr<IServices::ServiceDefinition> resolveDefinition(
    const json::Value &definition, uint32_t capabilities = 0) noexcept {
    IServices::ServiceDefinition def;
    def.definitionPath = file::Path{"fixture/services.json"};
    def.serviceDefinition = definition;
    def.capabilities = capabilities;
    if (auto ccode = IServices::buildSchema(def)) return ccode;
    return def;
}

// Resolves a fixture service definition into its schema
ErrorOr<json::Value> resolveFixture(const json::Value &definition,
                                    uint32_t capabilities = 0) noexcept {
    auto def = resolveDefinition(definition, capabilities);
    if (!def) return def.ccode();
    return def->serviceSchema;
}

// Collects every "path" in a resolved properties tree, recursing into
// groups, selector branches and array items
void collectPaths(const json::Value &properties,
                  std::vector<Text> &paths) noexcept {
    for (const auto &property : properties) {
        if (property.isMember("path"))
            paths.push_back(property["path"].asString());
        if (property.isMember("properties"))
            collectPaths(property["properties"], paths);
        if (property.isMember("item")) {
            json::Value items(json::arrayValue);
            items.append(property["item"]);
            collectPaths(items, paths);
        }
        if (property.isMember("enum") && property["enum"].isObject())
            for (const auto &branch : property["enum"].getMemberNames())
                collectPaths(property["enum"][branch]["properties"], paths);
    }
}

std::vector<Text> pathsOf(const json::Value &schema) noexcept {
    std::vector<Text> paths;
    collectPaths(schema["properties"], paths);
    return paths;
}

bool hasPath(const std::vector<Text> &paths, TextView path) noexcept {
    for (const auto &candidate : paths)
        if (candidate == path) return true;
    return false;
}

// Wraps a "properties" array into a minimal service definition
json::Value fixture(const json::Value &propertyDefinitions,
                    const json::Value &properties) noexcept {
    json::Value def;
    def["title"] = "Fixture";
    def["protocol"] = "fixture://";
    def["propertyDefinitions"] = propertyDefinitions;
    def["properties"] = properties;
    return def;
}

}  // namespace

//-----------------------------------------------------------------------------
// The Google Workspace shape of the plan: a selector whose branches share
// one leaf by the identical specifier (hoisted), hold branch-specific
// leaves, and nest a second selector
//-----------------------------------------------------------------------------
TEST_CASE("store::Services::paths") {
    const auto definitions = R"({
        "gw.authType": {
            "type": "string",
            "title": "Authentication Type",
            "default": "service",
            "enum": {
                "service": {
                    "title": "Service",
                    "properties": [
                        "gw.customerId", "gw.adminEmail", "gw.serviceKey",
                        "gw.access", "gw.scope"
                    ]
                },
                "user": {
                    "title": "User",
                    "properties": ["gw.userAuth", "gw.access"]
                }
            }
        },
        "gw.scope": {
            "type": "string",
            "title": "Scope",
            "default": "domain",
            "enum": {
                "domain": { "title": "Domain", "properties": ["gw.domainName"] },
                "ou": { "title": "Org unit", "properties": ["gw.orgUnit"] }
            }
        },
        "gw.access": {
            "type": "string",
            "title": "Access",
            "default": "readonly",
            "param": true,
            "enum": [["readonly", "Read only"], ["readwrite", "Read/write"]]
        },
        "gw.maxResults": {
            "type": "integer",
            "title": "Max results",
            "description": ["Upper bound on ", "results per call."],
            "default": 100,
            "minimum": 1,
            "maximum": 500,
            "param": true
        },
        "gw.userAuth": { "title": "Login with Google", "type": "oauth2" },
        "gw.customerId": { "type": "string", "title": "Customer ID" },
        "gw.adminEmail": { "type": "string", "title": "Administrator E-mail" },
        "gw.serviceKey": { "type": "upload", "title": "Service Account Key File" },
        "gw.domainName": { "type": "string", "title": "Domain" },
        "gw.orgUnit": { "type": "string", "title": "Org unit" }
    })"_json;

    const auto properties =
        R"(["type", "gw.authType", "gw.maxResults"])"_json;

    auto schema = resolveFixture(fixture(definitions, properties));
    REQUIRE_NO_ERROR(schema);

    const auto paths = pathsOf(*schema);

    SECTION("root leaves and the selector are at the root") {
        REQUIRE(hasPath(paths, "type"));
        REQUIRE(hasPath(paths, "authType"));
        REQUIRE(hasPath(paths, "maxResults"));
    }

    SECTION("a leaf referenced identically in every branch is hoisted") {
        REQUIRE(hasPath(paths, "access"));
        REQUIRE_FALSE(hasPath(paths, "service.access"));
        REQUIRE_FALSE(hasPath(paths, "user.access"));
    }

    SECTION("branch-specific leaves are at parent + branch + leaf") {
        REQUIRE(hasPath(paths, "service.customerId"));
        REQUIRE(hasPath(paths, "service.adminEmail"));
        REQUIRE(hasPath(paths, "service.serviceKey"));
        REQUIRE(hasPath(paths, "user.userAuth"));
    }

    SECTION("a nested selector is a leaf of its branch; its branches nest") {
        REQUIRE(hasPath(paths, "service.scope"));
        REQUIRE(hasPath(paths, "service.domain.domainName"));
        REQUIRE(hasPath(paths, "service.ou.orgUnit"));
    }

    SECTION("params are flat descriptors in schema order, flag stripped") {
        const auto &params = (*schema)["params"];
        REQUIRE(params.isArray());
        REQUIRE(params.size() == 2u);

        // The hoisted selector-shared leaf comes first: the selector
        // precedes maxResults in the root list
        const auto &access = params[0];
        REQUIRE(access["field"] == "access");
        REQUIRE(access["type"] == "string");
        REQUIRE(access["title"] == "Access");
        REQUIRE(access["default"] == "readonly");
        REQUIRE(access["enum"].size() == 2u);
        REQUIRE(access["enum"][0] == "readonly");
        REQUIRE(access["enum"][1] == "readwrite");
        REQUIRE_FALSE(access.isMember("minimum"));

        const auto &maxResults = params[1];
        REQUIRE(maxResults["field"] == "maxResults");
        REQUIRE(maxResults["type"] == "integer");
        REQUIRE(maxResults["description"] ==
                "Upper bound on results per call.");
        REQUIRE(maxResults["default"] == 100);
        REQUIRE(maxResults["minimum"] == 1);
        REQUIRE(maxResults["maximum"] == 500);
        REQUIRE_FALSE(maxResults.isMember("enum"));

        // The flag never reaches the schema - also not on the hoisted
        // copy placed into each branch
        for (const auto &branch : {"service", "user"})
            for (const auto &property :
                 (*schema)["properties"][1]["enum"][branch]["properties"])
                REQUIRE_FALSE(property.isMember("param"));
        REQUIRE_FALSE((*schema)["properties"][2].isMember("param"));
    }

    SECTION("the capabilities bitmask rides on the schema") {
        REQUIRE((*schema)["capabilities"].isUInt());
        REQUIRE((*schema)["capabilities"].asUInt() == 0u);

        auto certified = resolveFixture(
            fixture(definitions, properties),
            url::UrlConfig::PROTOCOL_CAPS::MULTITENANT);
        REQUIRE_NO_ERROR(certified);
        REQUIRE(((*certified)["capabilities"].asUInt() &
                 url::UrlConfig::PROTOCOL_CAPS::MULTITENANT) != 0);
    }
}

//-----------------------------------------------------------------------------
// Groups and arrays
//-----------------------------------------------------------------------------
TEST_CASE("store::Services::groupsAndArrays") {
    const auto definitions = R"({
        "fx.host": { "type": "string", "title": "Host" },
        "fx.pattern": { "type": "string", "title": "Pattern" }
    })"_json;

    const auto properties = R"([
        { "name": "server", "properties": ["fx.host"] },
        { "name": "include", "type": "array", "item": "fx.pattern" }
    ])"_json;

    auto schema = resolveFixture(fixture(definitions, properties));
    REQUIRE_NO_ERROR(schema);

    const auto paths = pathsOf(*schema);

    SECTION("a group has no path; its children carry the dotted path") {
        REQUIRE_FALSE((*schema)["properties"][0].isMember("path"));
        REQUIRE(hasPath(paths, "server.host"));
    }

    SECTION("an array is a leaf; its item is relative to the array") {
        REQUIRE(hasPath(paths, "include"));
        REQUIRE(hasPath(paths, "include[].pattern"));
    }
}

//-----------------------------------------------------------------------------
// "param" placement is a load error wherever a value would not resolve
// context-free, or would be credential-shaped
//-----------------------------------------------------------------------------
TEST_CASE("store::Services::paramErrors") {
    const auto definitions = R"({
        "fx.mode": {
            "type": "string",
            "default": "a",
            "enum": {
                "a": { "title": "A", "properties": ["fx.inBranch"] },
                "b": { "title": "B", "properties": [] }
            }
        },
        "fx.inBranch": { "type": "string", "title": "In branch", "param": true },
        "fx.item": { "type": "string", "title": "Item", "param": true },
        "fx.secret": { "type": "string", "title": "Token", "secret": true },
        "fx.env": { "type": "string", "title": "Key", "env": "ROCKETRIDE_FX_KEY" },
        "fx.login": { "type": "oauth2", "title": "Login", "param": true },
        "fx.file": { "type": "upload", "title": "File", "param": true },
        "fx.group": { "name": "group", "properties": ["fx.plain"], "param": true },
        "fx.plain": { "type": "string", "title": "Plain" }
    })"_json;

    SECTION("inside an enum branch, naming the property") {
        auto schema = resolveFixture(fixture(definitions, R"(["fx.mode"])"_json));
        REQUIRE_ERROR(schema, Ec::InvalidParam,
                      "\"param\" on property inBranch in");
        REQUIRE(schema.ccode().message().contains(
            "is not allowed inside an enum branch"));
    }

    SECTION("inside an array item") {
        auto schema = resolveFixture(fixture(
            definitions,
            R"([{ "name": "list", "type": "array", "item": "fx.item" }])"_json));
        REQUIRE_ERROR(schema, Ec::InvalidParam, "\"param\" on property item in");
        REQUIRE(schema.ccode().message().contains(
            "is not allowed inside an array item"));
    }

    SECTION("on a constant") {
        auto schema = resolveFixture(
            fixture(definitions, R"([{ "base": "type", "param": true }])"_json));
        REQUIRE_ERROR(schema, Ec::InvalidParam,
                      "is not allowed on a constant property");
    }

    SECTION("on oauth2 and upload") {
        auto login = resolveFixture(fixture(definitions, R"(["fx.login"])"_json));
        REQUIRE_ERROR(login, Ec::InvalidParam,
                      "is not allowed on a oauth2 property");

        auto file = resolveFixture(fixture(definitions, R"(["fx.file"])"_json));
        REQUIRE_ERROR(file, Ec::InvalidParam,
                      "is not allowed on a upload property");
    }

    SECTION("a {base, ...} override adding secret or env is seen") {
        auto secret = resolveFixture(fixture(
            definitions, R"([{ "base": "fx.secret", "param": true }])"_json));
        REQUIRE_ERROR(secret, Ec::InvalidParam,
                      "is not allowed on a secret property");

        auto env = resolveFixture(fixture(
            definitions, R"([{ "base": "fx.env", "param": true }])"_json));
        REQUIRE_ERROR(env, Ec::InvalidParam,
                      "is not allowed on an env-backed property");

        // ... and the reverse: a plain base gaining param through the
        // override, plus env through the same override
        auto both = resolveFixture(fixture(
            definitions,
            R"([{ "base": "fx.plain", "param": true, "env": "ROCKETRIDE_FX" }])"_json));
        REQUIRE_ERROR(both, Ec::InvalidParam,
                      "is not allowed on an env-backed property");
    }

    SECTION("on a group or an array") {
        auto group = resolveFixture(fixture(definitions, R"(["fx.group"])"_json));
        REQUIRE_ERROR(group, Ec::InvalidParam,
                      "is only allowed on a plain field or an enum selector");

        auto list = resolveFixture(fixture(
            definitions,
            R"([{ "name": "list", "type": "array", "item": "fx.plain", "param": true }])"_json));
        REQUIRE_ERROR(list, Ec::InvalidParam,
                      "is only allowed on a plain field or an enum selector");
    }

    SECTION("a non-boolean flag") {
        auto schema = resolveFixture(fixture(
            definitions, R"([{ "base": "fx.plain", "param": "yes" }])"_json));
        REQUIRE_ERROR(schema, Ec::InvalidParam, "must be a boolean");
    }

    SECTION("a selector may itself be a param") {
        auto schema = resolveFixture(fixture(
            definitions,
            R"([{ "base": "fx.mode", "param": true, "enum": {
                "a": { "title": "A", "properties": ["fx.plain"] },
                "b": { "title": "B", "properties": ["fx.plain"] } } }])"_json));
        REQUIRE_NO_ERROR(schema);
        REQUIRE((*schema)["params"].size() == 1u);
        REQUIRE((*schema)["params"][0]["field"] == "mode");
        REQUIRE((*schema)["params"][0]["enum"].size() == 2u);
    }
}

//-----------------------------------------------------------------------------
// Branch names and leaf names share one namespace per level
//-----------------------------------------------------------------------------
TEST_CASE("store::Services::levelNamespace") {
    const auto definitions = R"({
        "fx.mode": {
            "type": "string",
            "default": "cloud",
            "enum": {
                "cloud": { "title": "Cloud", "properties": ["fx.host"] },
                "local": { "title": "Local", "properties": ["fx.host"] }
            }
        },
        "fx.host": { "type": "string", "title": "Host" },
        "fx.cloud": { "type": "string", "title": "Cloud" }
    })"_json;

    SECTION("a root leaf colliding with a branch name") {
        auto schema = resolveFixture(
            fixture(definitions, R"(["fx.mode", "fx.cloud"])"_json));
        REQUIRE_ERROR(schema, Ec::InvalidParam, "Duplicate property name cloud");
    }

    SECTION("a root leaf colliding with a hoisted leaf") {
        auto schema = resolveFixture(
            fixture(definitions, R"(["fx.mode", "fx.host"])"_json));
        REQUIRE_ERROR(schema, Ec::InvalidParam, "Duplicate property name host");
    }

    SECTION("per-branch definitions sharing a short name are not hoisted") {
        auto perBranch = definitions;
        perBranch["fx.cloudHost"] = R"({ "base": "fx.host", "name": "host" })"_json;
        perBranch["fx.mode"]["enum"]["cloud"]["properties"] =
            R"(["fx.cloudHost"])"_json;

        auto schema = resolveFixture(fixture(perBranch, R"(["fx.mode"])"_json));
        REQUIRE_NO_ERROR(schema);

        const auto paths = pathsOf(*schema);
        REQUIRE(hasPath(paths, "cloud.host"));
        REQUIRE(hasPath(paths, "local.host"));
        REQUIRE_FALSE(hasPath(paths, "host"));
    }
}

//-----------------------------------------------------------------------------
// Secret and readonly leaves are registered by path for the stored config's
// encrypt/decrypt - a root leaf by its name, a branch leaf by parent.branch.leaf
//-----------------------------------------------------------------------------
TEST_CASE("store::Services::secureParameters") {
    const auto definitions = R"({
        "fx.mode": {
            "type": "string",
            "default": "cloud",
            "enum": {
                "cloud": { "title": "Cloud", "properties": ["fx.apikey", "fx.region"] },
                "local": { "title": "Local", "properties": ["fx.region"] }
            }
        },
        "fx.apikey": { "type": "string", "title": "API key", "secret": true },
        "fx.region": { "type": "string", "title": "Region", "readonly": true },
        "fx.token": { "type": "string", "title": "Token", "secret": true },
        "fx.plain": { "type": "string", "title": "Plain" }
    })"_json;

    auto def = resolveDefinition(
        fixture(definitions, R"(["fx.token", "fx.mode", "fx.plain"])"_json));
    REQUIRE_NO_ERROR(def);
    const auto &secure = def->secureParameters;

    SECTION("a secret root leaf is registered under its name") {
        REQUIRE(secure.count("token") == 1u);
        REQUIRE(secure.at("token") == PARAM_TYPE::SECURE);
    }

    SECTION("a secret leaf inside a branch is registered under its path") {
        REQUIRE(secure.count("cloud.apikey") == 1u);
        REQUIRE(secure.at("cloud.apikey") == PARAM_TYPE::SECURE);
        REQUIRE(secure.count("apikey") == 0u);
    }

    SECTION("a secret inside an array item is a load error") {
        // The encrypt/decrypt walk has no "[]" semantics, so such a value
        // could never be protected: refuse it at load, like "param"
        const auto itemDefs = R"({
            "fx.key": { "type": "string", "title": "Key", "secret": true }
        })"_json;
        auto schema = resolveFixture(fixture(
            itemDefs,
            R"([{ "name": "keys", "type": "array", "item": "fx.key" }])"_json));
        REQUIRE_ERROR(schema, Ec::InvalidParam, "\"secret\" on property key in");
        REQUIRE(schema.ccode().message().contains(
            "is not allowed inside an array item"));
    }

    SECTION("a secret in a selector branch inside an array item is a load error") {
        // The item rule outranks the branch rule: the walk cannot reach a
        // value under "[]" whichever branch is active
        const auto itemDefs = R"({
            "fx.kind": {
                "type": "string",
                "default": "cloud",
                "enum": {
                    "cloud": { "title": "Cloud", "properties": ["fx.key"] },
                    "local": { "title": "Local", "properties": [] }
                }
            },
            "fx.key": { "type": "string", "title": "Key", "secret": true }
        })"_json;
        auto schema = resolveFixture(fixture(
            itemDefs,
            R"([{ "name": "targets", "type": "array", "item": "fx.kind" }])"_json));
        REQUIRE_ERROR(schema, Ec::InvalidParam, "\"secret\" on property key in");
        REQUIRE(schema.ccode().message().contains(
            "is not allowed inside an array item"));
    }

    SECTION("a hoisted readonly leaf is registered once, at the hoisted path") {
        REQUIRE(secure.count("region") == 1u);
        REQUIRE(secure.at("region") == PARAM_TYPE::READONLY);
        REQUIRE(secure.count("cloud.region") == 0u);
        REQUIRE(secure.count("local.region") == 0u);
    }

    SECTION("plain leaves are not registered") {
        REQUIRE(secure.count("plain") == 0u);
        REQUIRE(secure.count("mode") == 0u);
        REQUIRE(secure.size() == 3u);
    }

    SECTION("a {base, ...} override adding secret is registered") {
        auto overridden = resolveDefinition(fixture(
            definitions, R"([{ "base": "fx.plain", "secret": true }])"_json));
        REQUIRE_NO_ERROR(overridden);
        REQUIRE(overridden->secureParameters.at("plain") == PARAM_TYPE::SECURE);
    }
}

//-----------------------------------------------------------------------------
// Alias chains resolve; alias cycles are a load error naming the alias
//-----------------------------------------------------------------------------
TEST_CASE("store::Services::aliasCycles") {
    SECTION("a self-referencing alias") {
        auto schema = resolveFixture(fixture(
            R"({ "fx.self": { "base": "fx.self", "title": "Self" } })"_json,
            R"(["fx.self"])"_json));
        REQUIRE_ERROR(schema, Ec::InvalidParam,
                      "Property alias fx.self refers back to itself in");
    }

    SECTION("a mutual alias cycle") {
        auto schema = resolveFixture(fixture(
            R"({ "fx.a": { "base": "fx.b" }, "fx.b": { "base": "fx.a" } })"_json,
            R"(["fx.a"])"_json));
        REQUIRE_ERROR(schema, Ec::InvalidParam,
                      "Property alias fx.a refers back to itself in");
    }

    SECTION("a cycle reached through an inline {base, ...} specifier") {
        auto schema = resolveFixture(fixture(
            R"({ "fx.a": { "base": "fx.b" }, "fx.b": { "base": "fx.a" } })"_json,
            R"([{ "base": "fx.a", "title": "Inline" }])"_json));
        REQUIRE_ERROR(schema, Ec::InvalidParam, "refers back to itself in");
    }

    SECTION("a non-cyclic three-deep chain expands, overrides layered") {
        auto schema = resolveFixture(fixture(
            R"({
                "fx.a": { "base": "fx.b", "default": "from-a" },
                "fx.b": { "base": "fx.c", "title": "From B" },
                "fx.c": { "type": "string", "title": "From C", "default": "from-c" }
            })"_json,
            R"(["fx.a"])"_json));
        REQUIRE_NO_ERROR(schema);
        const auto &leaf = (*schema)["properties"][0];
        REQUIRE(leaf["name"] == "a");
        REQUIRE(leaf["path"] == "a");
        REQUIRE(leaf["type"] == "string");
        REQUIRE(leaf["title"] == "From B");
        REQUIRE(leaf["default"] == "from-a");
        REQUIRE_FALSE(leaf.isMember("base"));
    }
}

//-----------------------------------------------------------------------------
// The old services.json format is a hard load error naming the file
//-----------------------------------------------------------------------------
TEST_CASE("store::Services::oldFormat") {
    const file::Path path{"nodes/fixture/services.json"};

    SECTION("a property definition file declaring fields") {
        const auto ccode =
            IServices::requireNewFormat(R"({ "fields": {} })"_json, path);
        REQUIRE_ERROR(ccode, Ec::InvalidJson,
                      "Old-format property definitions (\"fields\") are not "
                      "supported - declare \"propertyDefinitions\" in");
        REQUIRE(ccode.message().contains("services.json"));
    }

    SECTION("a service definition declaring shape") {
        const auto ccode = IServices::requireNewFormat(
            R"({ "protocol": "fx://", "fields": {}, "shape": [] })"_json, path);
        REQUIRE_ERROR(ccode, Ec::InvalidJson,
                      "Old-format service definition (\"shape\") is not "
                      "supported - declare \"properties\" in");
        REQUIRE(ccode.message().contains("services.json"));
    }

    SECTION("a service definition with no properties at all") {
        const auto ccode = IServices::requireNewFormat(
            R"({ "protocol": "fx://" })"_json, path);
        REQUIRE_ERROR(ccode, Ec::InvalidJson, "declare \"properties\" in");
        REQUIRE(ccode.message().contains("services.json"));
    }

    SECTION("the new format loads") {
        REQUIRE_NO_ERROR(IServices::requireNewFormat(
            R"({ "propertyDefinitions": {} })"_json, path));
        REQUIRE_NO_ERROR(IServices::requireNewFormat(
            R"({ "protocol": "fx://", "properties": [] })"_json, path));
    }
}

//-----------------------------------------------------------------------------
// The directory walk init() runs refuses an old-format definition file: the
// load fails and the error names the file, so a stale node cannot be loaded
//-----------------------------------------------------------------------------
TEST_CASE("store::Services::oldFormatFailsLoad") {
    const auto root = testPath() / "services-old-format";
    const auto nodeDir = root / "stale_node";
    if (!file::exists(root)) REQUIRE_NO_ERROR(file::mkdir(root));
    if (!file::exists(nodeDir)) REQUIRE_NO_ERROR(file::mkdir(nodeDir));

    const auto definition = nodeDir / "services.json";
    REQUIRE_NO_ERROR(file::put(
        definition,
        R"({ "protocol": "stale://", "fields": {}, "shape": [] })"_tv));

    const auto ccode = IServices::loadServices(root, (Text) "*");
    REQUIRE_ERROR(ccode, Ec::InvalidJson,
                  "Old-format service definition (\"shape\") is not "
                  "supported - declare \"properties\" in");
    REQUIRE(ccode.message().contains("stale_node"));
    REQUIRE(ccode.message().contains("services.json"));

    // The refused file registered nothing
    REQUIRE_FALSE(IServices::getServiceDefinition((Text) "stale"));

    *file::remove(definition);
}

//-----------------------------------------------------------------------------
// A caller's own node definitions, passed as JSON with one call (develop
// #2764, node rail 1a): parsed and expanded by the same property-model
// parser as a scanned file, seen only by that call, never registered
//-----------------------------------------------------------------------------
TEST_CASE("store::Services::custom") {
    // Custom services are seen by the lookups of the call they came with,
    // and the registry is the same before and after
    SECTION("custom services: call-scoped") {
        REQUIRE_FALSE(IServices::getServiceDefinition("custom_a"));

        {
            auto scope = IServices::withCustomServices(
                customList({customNode("custom_a")}));
            REQUIRE_NO_ERROR(scope);

            auto def = IServices::getServiceDefinition("custom_a");
            REQUIRE(def);
            CHECK((*def)->title == "custom_a");
            CHECK((*def)->serviceSchema["properties"].isArray());
            CHECK((*def)->serviceSchema["params"].isArray());
            CHECK(IServices::isCustomService("custom_a"));

            auto schemas = IServices::getServiceSchemas();
            REQUIRE_NO_ERROR(schemas);
            CHECK((*schemas)["services"].isMember("custom_a"));
            CHECK((*schemas)["services"]["custom_a"]["icon"].asString() ==
                  "data:image/svg+xml;base64,PHN2Zy8+");
        }

        REQUIRE_FALSE(IServices::getServiceDefinition("custom_a"));
        CHECK_FALSE(IServices::isCustomService("custom_a"));
        auto schemas = IServices::getServiceSchemas();
        REQUIRE_NO_ERROR(schemas);
        REQUIRE_FALSE((*schemas)["services"].isMember("custom_a"));

        // Nothing is registered for it either
        const auto names = Factory::getFactories("iFilterGlobal");
        REQUIRE(std::find(names.begin(), names.end(), iTextView{"custom_a"}) ==
                names.end());

        // A registered node is not a custom one
        CHECK_FALSE(IServices::isCustomService(registeredType()));
    }

    SECTION("custom services: nest") {
        auto outer = IServices::withCustomServices(
            customList({customNode("custom_outer")}));
        REQUIRE_NO_ERROR(outer);

        {
            auto inner = IServices::withCustomServices(
                customList({customNode("custom_inner")}));
            REQUIRE_NO_ERROR(inner);
            CHECK(IServices::getServiceDefinition("custom_inner"));
        }

        CHECK(IServices::getServiceDefinition("custom_outer"));
        CHECK_FALSE(IServices::getServiceDefinition("custom_inner"));
    }

    // A caller's definition is walked recursively, so its nesting is
    // bounded (64 levels) before a deep one could exhaust the stack
    SECTION("custom services: nesting depth") {
        const auto nest = [](int levels) {
            json::Value nested = "leaf";
            for (int level = 0; level < levels; level++) {
                json::Value wrap;
                wrap["x"] = _mv(nested);
                nested = _mv(wrap);
            }
            return nested;
        };

        // JSON nested within the limit is accepted ...
        auto shallow = customNode("custom_shallow");
        shallow["extra"] = nest(32);
        REQUIRE(IServices::withCustomServices(customList({shallow})));

        // ... and nested past it is refused, naming the limit
        auto deep = customNode("custom_deep");
        deep["extra"] = nest(100);
        auto deepJson = IServices::withCustomServices(customList({deep}));
        REQUIRE_FALSE(deepJson);
        CHECK(std::string{deepJson.ccode().message()}.find(
                  "nests deeper than 64 levels") != std::string::npos);

        // Flat property definitions that chain through references: each
        // group lists the next, no cycle, 100 expansions deep
        auto chain = customNode("custom_chain");
        for (int level = 0; level < 100; level++) {
            auto &group =
                chain["propertyDefinitions"][_ts("custom_chain.g", level)];
            group["name"] = _ts("g", level);
            group["properties"].append(_ts("custom_chain.g", level + 1));
        }
        chain["propertyDefinitions"]["custom_chain.g100"] =
            R"({"type": "string"})"_json;
        chain["properties"].append("custom_chain.g0");

        auto deepChain = IServices::withCustomServices(customList({chain}));
        REQUIRE_FALSE(deepChain);
        CHECK(std::string{deepChain.ccode().message()}.find(
                  "nest deeper than 64 levels") != std::string::npos);
        CHECK_FALSE(IServices::getServiceDefinition("custom_chain"));
    }

    // The same property-model parse as a scanned file: paths, params, the
    // capabilities bitmask and the secret registrations
    SECTION("custom services: the property model") {
        auto node = customNode("custom_pm");
        node["capabilities"].append("multitenant");
        node["propertyDefinitions"] = R"({
            "custom_pm.size": {
                "type": "integer", "title": "Size", "default": 1,
                "minimum": 1, "maximum": 8, "param": true
            },
            "custom_pm.apikey": { "type": "string", "title": "Key", "secret": true },
            "custom_pm.mode": {
                "type": "string", "title": "Mode", "default": "cloud",
                "enum": {
                    "cloud": { "title": "Cloud", "properties": ["custom_pm.host"] },
                    "local": { "title": "Local", "properties": ["custom_pm.host"] }
                }
            },
            "custom_pm.host": { "type": "string", "title": "Host" }
        })"_json;
        node["properties"] =
            R"(["custom_pm.size", "custom_pm.apikey", "custom_pm.mode"])"_json;

        auto scope = IServices::withCustomServices(customList({node}));
        REQUIRE_NO_ERROR(scope);
        auto def = IServices::getServiceDefinition("custom_pm");
        REQUIRE(def);

        const auto &schema = (*def)->serviceSchema;
        REQUIRE(schema["params"].size() == 1u);
        CHECK(schema["params"][0]["field"] == "size");
        CHECK(schema["params"][0]["maximum"] == 8);
        CHECK(schema["properties"][0]["path"] == "size");
        CHECK_FALSE(schema["properties"][0].isMember("param"));
        CHECK((schema["capabilities"].asUInt() &
               url::UrlConfig::PROTOCOL_CAPS::MULTITENANT) != 0);

        // The leaf listed in both branches is hoisted to the root
        const auto &cloud = schema["properties"][2]["enum"]["cloud"];
        CHECK(cloud["properties"][0]["path"] == "host");

        // The secret leaf is registered by its path
        REQUIRE((*def)->secureParameters.count("apikey"));
        CHECK((*def)->secureParameters.at("apikey") == PARAM_TYPE::SECURE);
    }

    SECTION("custom services: defaults") {
        // A custom node with no title takes its logical type
        auto untitled = customNode("custom_untitled");
        untitled.removeMember("title");
        auto scope = IServices::withCustomServices(customList({untitled}));
        REQUIRE_NO_ERROR(scope);
        auto def = IServices::getServiceDefinition("custom_untitled");
        REQUIRE(def);
        CHECK((*def)->title == "custom_untitled");

        // An empty list is an empty scope
        REQUIRE(IServices::withCustomServices(json::Value{json::arrayValue}));
        REQUIRE(IServices::withCustomServices(json::Value{}));
    }

    SECTION("custom services: refused") {
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

        auto colonOnly = customNode("custom_j");
        colonOnly["protocol"] = ":";

        // The old format is refused, as it is in a scanned file
        auto oldFormat = customNode("custom_old");
        oldFormat.removeMember("propertyDefinitions");
        oldFormat.removeMember("properties");
        oldFormat["fields"] = R"({})"_json;
        oldFormat["shape"] = R"([])"_json;

        // A group that lists itself
        auto loop = customNode("custom_k");
        loop["propertyDefinitions"]["custom_k.loop"] =
            R"({"name": "loop", "properties": ["custom_k.loop"]})"_json;
        loop["properties"].append("custom_k.loop");

        // A selector whose only branch lists the selector
        auto branchLoop = customNode("custom_kb");
        branchLoop["propertyDefinitions"]["custom_kb.sel"] = R"({
            "type": "string", "title": "Sel",
            "enum": { "a": { "title": "A", "properties": ["custom_kb.sel"] } }
        })"_json;
        branchLoop["properties"].append("custom_kb.sel");

        // Two aliases of each other
        auto pingPong = customNode("custom_m");
        pingPong["propertyDefinitions"]["custom_m.a"] =
            R"({"base": "custom_m.b"})"_json;
        pingPong["propertyDefinitions"]["custom_m.b"] =
            R"({"base": "custom_m.a"})"_json;
        pingPong["properties"].append("custom_m.a");

        // A property definition that is not an object
        auto notObject = customNode("custom_no");
        notObject["propertyDefinitions"]["custom_no.x"] = "custom_no.x";
        notObject["properties"].append("custom_no.x");

        // A parameter on a secret: the parser's own load error
        auto secretParam = customNode("custom_sp");
        secretParam["propertyDefinitions"]["custom_sp.key"] = R"({
            "type": "string", "title": "Key", "secret": true, "param": true
        })"_json;
        secretParam["properties"].append("custom_sp.key");

        auto badLanes = customNode("custom_l");
        badLanes["lanes"] = customList({"x"});
        auto badTitle = customNode("custom_p");
        badTitle["title"] = R"({})"_json;
        auto badPrefix = customNode("custom_q");
        badPrefix["prefix"] = customList({"x"});

        // Read later as strings or lists, so refused when they are not
        auto badIcon = customNode("custom_s");
        badIcon["icon"] = R"({})"_json;
        auto badTarget = customNode("custom_t");
        badTarget["lanes"]["text"] = customList({R"({})"_json});
        auto badInput = customNode("custom_u");
        badInput["input"] = customList({"text"});
        auto badInputLane = customNode("custom_v");
        badInputLane["input"] = customList({R"({"lane": {}})"_json});
        auto badOutput = customNode("custom_w");
        badOutput["input"] =
            customList({R"({"lane": "text", "output": "text"})"_json});
        auto badTile = customNode("custom_x");
        badTile["tile"] = customList({R"({})"_json});

        // Each group lists the next one twice: no cycle, 2^16 references
        auto fanOut = customNode("custom_r");
        for (int level = 0; level < 15; level++) {
            auto &group = fanOut["propertyDefinitions"][_ts("custom_r.f", level)];
            group["name"] = _ts("s", level);
            for (const char *copy : {"a", "b"}) {
                json::Value ref;
                ref["base"] = _ts("custom_r.f", level + 1);
                ref["name"] = copy;
                group["properties"].append(ref);
            }
        }
        fanOut["propertyDefinitions"]["custom_r.f15"] =
            R"({"type": "string"})"_json;
        fanOut["properties"].append("custom_r.f0");

        // A big property listed many times: few references, a large copy
        // each time (1000 references, about 10^6 JSON values)
        auto heavy = customNode("custom_y");
        auto &big = heavy["propertyDefinitions"]["custom_y.big"];
        big["type"] = "string";
        for (int value = 0; value < 1000; value++)
            big["enum"].append(_ts("v", value));
        for (int copy = 0; copy < 1000; copy++) {
            json::Value ref;
            ref["base"] = "custom_y.big";
            ref["name"] = _ts("c", copy);
            heavy["properties"].append(ref);
        }

        // Each definition stays under its own budget (about 60 000 JSON
        // values); twenty of them together go past the call's
        json::Value many = json::arrayValue;
        for (int copy = 0; copy < 20; copy++) {
            const auto name = _ts("custom_many", copy);
            auto def = customNode(name.c_str());
            auto &field = def["propertyDefinitions"][_ts(name, ".big")];
            field["type"] = "string";
            for (int value = 0; value < 1000; value++)
                field["enum"].append(_ts("v", value));
            for (int ref = 0; ref < 60; ref++) {
                json::Value spec;
                spec["base"] = _ts(name, ".big");
                spec["name"] = _ts("c", ref);
                def["properties"].append(spec);
            }
            many.append(def);
        }

        const json::Value refused[] = {
            customList({shadow}),
            customList({customNode("custom_g"), customNode("custom_g")}),
            customList({iconFile}),
            customList({noProtocol}),
            customList({badCap}),
            customList({cppNoLibrary}),
            customList({"custom_h"}),
            customNode("custom_i"),
            customList({colonOnly}),
            customList({oldFormat}),
            customList({loop}),
            customList({branchLoop}),
            customList({pingPong}),
            customList({notObject}),
            customList({secretParam}),
            customList({badLanes}),
            customList({badTitle}),
            customList({badPrefix}),
            customList({badIcon}),
            customList({badTarget}),
            customList({badInput}),
            customList({badInputLane}),
            customList({badOutput}),
            customList({badTile}),
            customList({fanOut}),
            customList({heavy}),
            many,
        };
        for (const auto &custom : refused)
            REQUIRE_FALSE(IServices::withCustomServices(custom));

        // ":" names no logical type: refused before anything reads one
        auto colon = IServices::withCustomServices(customList({colonOnly}));
        REQUIRE_FALSE(colon);
        CHECK(std::string{colon.ccode().message()}.find("No logical type") !=
              std::string::npos);

        // The old format names what to declare instead
        auto old = IServices::withCustomServices(customList({oldFormat}));
        REQUIRE_FALSE(old);
        CHECK(std::string{old.ccode().message()}.find(
                  "declare \"properties\"") != std::string::npos);

        // A property inside its own expansion is named
        for (const auto &custom : {customList({loop}), customList({branchLoop})}) {
            auto cycle = IServices::withCustomServices(custom);
            REQUIRE_FALSE(cycle);
            CHECK(std::string{cycle.ccode().message()}.find(
                      "contains itself") != std::string::npos);
        }

        // The budget names the definition that went past it
        for (const auto &custom : {customList({fanOut}), customList({heavy})}) {
            auto expanded = IServices::withCustomServices(custom);
            REQUIRE_FALSE(expanded);
            CHECK(std::string{expanded.ccode().message()}.find(
                      "expand to more than") != std::string::npos);
        }

        // One of them alone is accepted; the call's budget names the list
        REQUIRE(IServices::withCustomServices(customList({many[0]})));
        auto together = IServices::withCustomServices(many);
        REQUIRE_FALSE(together);
        CHECK(std::string{together.ccode().message()}.find(
                  "expand to more than 1000000 JSON values together") !=
              std::string::npos);

        // A registered type keeps its own definition
        REQUIRE(IServices::getServiceDefinition(registeredType()));
        CHECK_FALSE(IServices::getServiceDefinition("custom_g"));
    }

    // The Python surface: the catalogue and validation take the same list
    SECTION("custom services: rocketlib") {
        const auto python = localfcn()->Error {
            py::module_::import("__main__").attr("custom") =
                engine::python::pyjson::jsonToDict(customNode("custom_py"));
            py::exec(R"(
import engLib, rocketlib, json
assert 'custom_py' in rocketlib.getServiceDefinitions(custom=[custom])['services']
assert 'custom_py' not in rocketlib.getServiceDefinitions()['services']

shadow = dict(custom, protocol=next(iter(rocketlib.getServiceDefinitions()['services'])) + '://')
try:
    rocketlib.getServiceDefinitions(custom=[shadow])
    raise AssertionError('a custom service that shadows a registered one was accepted')
except AssertionError:
    raise
except Exception:
    pass

# The old format is refused through the Python surface as well
old = {k: v for k, v in custom.items() if k not in ('propertyDefinitions', 'properties')}
old.update(fields={}, shape=[])
try:
    rocketlib.getServiceDefinitions(custom=[old])
    raise AssertionError('an old-format custom service was accepted')
except AssertionError:
    raise
except Exception:
    pass

# Validation encrypts what the definition marks secret: a user's node secret
# stays in the clear unless validation sees the custom definition. The value
# lives at its path from the config root
secret = dict(custom, propertyDefinitions={'custom_py.apikey': {'type': 'string', 'title': 'Key', 'secret': True}},
              properties=['custom_py.apikey'])
def pipeline():
    return {'pipeline': {'source': 'c1', 'version': 1, 'components': [
        {'id': 'c1', 'provider': 'custom_py', 'config': {'apikey': 's3cret-key'}}]}}
assert 's3cret-key' in json.dumps(rocketlib.validatePipeline(pipeline()))
validated = json.dumps(rocketlib.validatePipeline(pipeline(), custom=[secret]))
assert 's3cret-key' not in validated and 'secureParameters' in validated, validated

# The component form too: the node has no factory here, so only the schema
# checks and the encryption apply
def component():
    return {'component': {'id': 'c1', 'provider': 'custom_py', 'config': {'apikey': 's3cret-key'}}}
validated = rocketlib.validatePipeline(component(), custom=[secret])
assert 'errors' not in validated, validated
assert 's3cret-key' not in json.dumps(validated) and 'secureParameters' in json.dumps(validated), validated

# ILoader.getPipeStack has no rocketlib wrapper; it is reached through engLib directly

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
}

namespace {

json::Value customNode(const char *name) {
    json::Value def = R"({
        "register": "filter", "node": "python", "classType": ["text"],
        "capabilities": [], "lanes": {"text": ["text"]},
        "propertyDefinitions": {}, "properties": [],
        "icon": "data:image/svg+xml;base64,PHN2Zy8+"
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

Text registeredType() {
    auto schemas = IServices::getServiceSchemas();
    REQUIRE_NO_ERROR(schemas);
    return (*schemas)["services"].getMemberNames().front();
}

}  // namespace
