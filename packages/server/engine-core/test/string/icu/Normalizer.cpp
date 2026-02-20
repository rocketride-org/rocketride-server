// =============================================================================
// RocketRide Engine
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

TEST_CASE("string::icu::Normalizer") {
    using namespace string::icu;

    const Text utf8 = u8"RocketRide™";
    const auto expecteNomrmalizedUtf8 = "RocketRideTM"_tv;
    const Utf16 utf16 = u"RocketRide™";
    const auto expectedNormalizedUtf16 = u"RocketRideTM"_tv;

    // Test NFKC normalization of UTF-8
    SECTION("UTF-8") {
        REQUIRE_FALSE(isNormalized(utf8));
        const auto normalized = *normalize(utf8, NormalizationForm::NFKC);
        REQUIRE(normalized == expecteNomrmalizedUtf8);
        REQUIRE(isNormalized(normalized));
    }

    // Test NFKC normalization of UTF-16
    SECTION("UTF-16") {
        REQUIRE_FALSE(isNormalized(utf16));
        const auto normalized = *normalize(utf16, NormalizationForm::NFKC);
        REQUIRE(normalized == expectedNormalizedUtf16);
        REQUIRE(isNormalized(normalized));
    }

    // Test NKFC normalization of UTF-8 using a stack allocator
    SECTION("UTF-8 with stack allocator") {
        StackTextArena arena;
        StackTextAllocator alloc(arena);
        const auto normalized =
            *normalize(utf8, NormalizationForm::NFKC, alloc);
        REQUIRE(normalized == expecteNomrmalizedUtf8);
        REQUIRE(normalized.get_allocator() == alloc);
    }

    // Test NKFC normalization of UTF-16 using a stack allocator
    SECTION("UTF-16 with stack allocator") {
        StackUtf16Arena arena;
        StackUtf16Allocator alloc(arena);
        const auto normalized =
            *normalize(utf16, NormalizationForm::NFKC, alloc);
        REQUIRE(normalized == expectedNormalizedUtf16);
        REQUIRE(normalized.get_allocator() == alloc);
    }
}
