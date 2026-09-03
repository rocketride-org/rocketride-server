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

    // react-jsonschema-form reads a scalar array's option labels off the array's
    // own ui schema, so the metadata processField builds for the items subfield
    // has to be lifted onto the array. Without that the config panel renders the
    // raw enum values instead of the labels the service authored.
    SECTION("scalar array enums keep their option metadata") {
        // tool_pipedrive is the only service with a scalar array enum, so it is
        // what this exercises; if it ever goes away, move the check rather than
        // letting it pass on an absent service.
        const auto &services = schema["services"];
        REQUIRE(services.isMember("tool_pipedrive"));

        const auto &ui = services["tool_pipedrive"]["Pipe"]["ui"]["toolGroups"];

        REQUIRE(ui.isMember("ui:enumNames"));
        REQUIRE(ui["ui:enumNames"][0].asString() == "Deals (27)");

        // The optional third element of an enum tuple rides along the same path
        REQUIRE(ui.isMember("ui:enumDescriptions"));
        REQUIRE(ui["ui:enumDescriptions"].size() == ui["ui:enumNames"].size());
        REQUIRE(!ui["ui:enumDescriptions"][0].asString().empty());
    }
}
