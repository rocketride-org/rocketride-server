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

/**
 * Pipeline that routes the json lane into the dedicated Return JSON response
 * node (response_json://), which writes each input lane into the object
 * results. The json values land in response["json"] as an array (one entry per
 * writeJson call), mirroring how the response node handles the table lane.
 */
class JsonFilterTest : public IFilterTest {
public:
    JsonFilterTest() : IFilterTest({"response_json"}) {}

    /// Returns the array of json values the response node captured, or a null
    /// value if the json lane was not written to the object results.
    json::Value getJsonResults() const noexcept {
        const auto &entry = getEntry();
        if (entry.response && entry.response().isObject()) {
            auto value = entry.response().lookup("json");
            if (value.isArray()) return value;
        }
        return {};
    }

    /// Returns the first captured json value (the common single-write case).
    json::Value getJson() const noexcept {
        auto results = getJsonResults();
        if (results.isArray() && !results.empty()) return results[0];
        return {};
    }
};

TEST_CASE("store::json") {
    //-----------------------------------------------------------------
    // The response node must capture a json-lane write into the object
    // results, preserving scalars, nested objects and arrays.
    //-----------------------------------------------------------------
    SECTION("response captures json object") {
        JsonFilterTest filter;

        // Build and connect the endpoint
        REQUIRE_NO_ERROR(filter.connect());

        // Get a source pipe, open a dummy object on it
        auto pipe = filter.openObject("test.json"_tv, Entry::FLAGS::INDEX);
        REQUIRE_NO_ERROR(pipe);

        // Build a representative payload: scalars, a nested object and an array
        json::Value data;
        data["title"] = "hello";
        data["count"] = 42;
        data["nested"]["label"] = "x";
        data["tags"].append("a");
        data["tags"].append("b");

        // Send it down the json lane
        REQUIRE_NO_ERROR(pipe->writeJson(data));

        // Close the object so the response node finalizes the result
        REQUIRE_NO_ERROR(filter.closeObject(*pipe));

        // The response node must have captured the json lane into the object
        // result. (Fails until the response node implements writeJson.)
        auto captured = filter.getJson();
        REQUIRE(captured.isObject());
        REQUIRE(captured.isMember("title"));
        REQUIRE(captured["title"].asString() == "hello");
        REQUIRE(captured["count"] == 42);
        REQUIRE(captured.isMember("nested"));
        REQUIRE(captured["nested"]["label"].asString() == "x");
        REQUIRE(captured["tags"].isArray());
        REQUIRE(captured["tags"].size() == 2);
    }

    //-----------------------------------------------------------------
    // Each json-lane write on an object must be captured as a separate
    // entry in the response array.
    //-----------------------------------------------------------------
    SECTION("response captures multiple json writes") {
        JsonFilterTest filter;

        REQUIRE_NO_ERROR(filter.connect());

        auto pipe = filter.openObject("test.json"_tv, Entry::FLAGS::INDEX);
        REQUIRE_NO_ERROR(pipe);

        for (int i = 0; i < 3; i++) {
            json::Value data;
            data["index"] = i;
            REQUIRE_NO_ERROR(pipe->writeJson(data));
        }

        REQUIRE_NO_ERROR(filter.closeObject(*pipe));

        // All three writes must be captured in order.
        auto results = filter.getJsonResults();
        REQUIRE(results.isArray());
        REQUIRE(results.size() == 3);
        REQUIRE(results[0]["index"] == 0);
        REQUIRE(results[2]["index"] == 2);
    }
}
