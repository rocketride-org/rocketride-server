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

TEST_CASE("string::icu::transform") {
    using namespace string::icu;

    const Text utf8 = "shamalamadingdong";
    const TextView utf8View = utf8;
    const Utf16 utf16 = utf8;
    const Utf16View utf16View = utf16;

    SECTION("Convert from TextView to icu::StringPiece") {
        const auto piece = _tr<StringPiece>(utf8View);
        REQUIRE(piece.size() == utf8View.size());
        REQUIRE(piece.data() == utf8View);
    }

    SECTION("Convert from TextView to icu::StringPiece") {
        const auto piece = _tr<StringPiece>(utf8);
        REQUIRE(piece.size() == utf8.size());
        REQUIRE(piece.data() == utf8);
    }

    SECTION("Convert from TextView to icu::UnicodeString") {
        const auto string = _tr<UnicodeString>(utf8View);
        REQUIRE(string.length() == utf16View.size());
        REQUIRE(_tr<Utf16View>(string) == utf16View);
    }

    SECTION("Convert from Text to icu::UnicodeString") {
        const auto string = _tr<UnicodeString>(utf8);
        REQUIRE(string.length() == utf16.size());
        REQUIRE(_tr<Utf16View>(string) == utf16);
    }

    SECTION("Convert from icu::UnicodeString to Text") {
        const auto string = _tr<UnicodeString>(utf8);
        auto compare = _tr<Text>(string);
        REQUIRE(compare == utf8);
    }

    SECTION("Convert from Utf16View to icu::UnicodeString") {
        const auto string = _tr<UnicodeString>(utf16View);
        REQUIRE(string.length() == utf16View.size());
        REQUIRE(_tr<Utf16View>(string) == utf16View);
    }

    SECTION("Convert from Utf16 to icu::UnicodeString") {
        auto string = _tr<UnicodeString>(utf16);
        REQUIRE(string.length() == utf16.size());
        REQUIRE(_tr<Utf16View>(string) == utf16);
    }

    SECTION("Convert from icu::UnicodeString to Utf16View") {
        const auto string = _tr<UnicodeString>(utf16);
        auto compare = _tr<Utf16View>(string);
        REQUIRE(compare == utf16);
    }

    SECTION("Convert from icu::UnicodeString to Utf16") {
        const auto string = _tr<UnicodeString>(utf16);
        auto compare = _tr<Utf16>(string);
        REQUIRE(compare == utf16);
    }
}