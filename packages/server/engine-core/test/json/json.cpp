// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

TEST_CASE("json::escape") {
    auto verify = [](TextView unescaped, TextView escaped) {
        REQUIRE(json::escape(unescaped) == escaped);
        REQUIRE(json::unescape(escaped) == unescaped);
    };

    verify("test", "test");
    verify("\"test\"", "\\\"test\\\"");
    verify("\\test", "\\\\test");
    verify("test\\", "test\\\\");
    verify("te\nst", "te\\nst");
    verify("test\r", "test\\r");
    verify("\ttest", "\\ttest");
}

TEST_CASE("json::exceptions") {
    // Using a JSON array as an object will cause a throw in JSON
    json::Value jarray(json::ValueType::arrayValue);
    // Verify that it throws as our exception type
    REQUIRE_THROWS_AS(jarray["key"] = 0, Error);
}