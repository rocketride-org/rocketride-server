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

static application::Opt TextInput{"--icu.text"};

TEST_CASE("string::icu::BoundaryIterator") {
    SECTION("StandardRules") {
        using StandardIter = string::TextBoundaryIter<string::icu::BaseRules>;

        SECTION("Basic parse") {
            auto results = *StandardIter::parseWords("A Very Simple Set! "_tv);
            REQUIRE(results.size() == 4);
            REQUIRE(results[0] == "A");
            REQUIRE(results[1] == "Very");
            REQUIRE(results[2] == "Simple");
            REQUIRE(results[3] == "Set");
        }
    }
}

TEST_CASE("string::icu::tokenize") {
    if (!TextInput) {
        LOG(Test, "--text not provided; skipping string::icu::tokenize test");
        return;
    }

    // Enable ICU logging so that the default word and rule status logging in
    // BoundaryIterator is used
    auto logScope = enableTestLogging(Lvl::Icu);

    LOG(Test, "Parsing: '{}'", *TextInput);
    size_t wordCount = 0;
    string::icu::BoundaryIterator<string::icu::BaseRules, Utf8Chr> it(
        _cast<TextView>(TextInput));
    while (it.next()) {
        ++wordCount;
    }
    LOG(Test, "Parsed {} words", wordCount);
}