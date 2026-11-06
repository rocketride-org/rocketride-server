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
