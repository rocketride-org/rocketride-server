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

TEST_CASE("string::unicode::surrogates") {
    using namespace string::unicode;

    // A surrogate pair, "tetragram for centre", U+1D306 (𝌆)
    const auto tetragram = u"\xd834\xdf06"_tv;

    // Not a surrogate pair, but it has the same number of characters
    const auto television = u"TV"_tv;

    // Build a string where every 5th codepoint is a surrogate pair
    _const size_t codepointsInTestString = 100;
    _const size_t surrogatePairInterval = 5;
    REQUIRE((codepointsInTestString % surrogatePairInterval) == 0);
    _const size_t repeatedRunsInTestString =
        codepointsInTestString / surrogatePairInterval;

    auto buildTestString = [&] {
        Utf16 string;
        for (size_t i = 0; i < codepointsInTestString; ++i) {
            if (!(i % surrogatePairInterval))
                string += tetragram;
            else
                string += television;
        }
        return string;
    };

    SECTION("string::unicode::isHighSurrogate") {
        REQUIRE(isHighSurrogate(tetragram[0]));
        REQUIRE_FALSE(isHighSurrogate(television[0]));
    }

    SECTION("string::unicode::isLowSurrogate") {
        REQUIRE(isLowSurrogate(tetragram[1]));
        REQUIRE_FALSE(isLowSurrogate(television[1]));
    }

    SECTION("string::unicode::isSurrogatePair") {
        REQUIRE(isSurrogatePair(tetragram));
        REQUIRE_FALSE(isSurrogatePair(television));
    }

    SECTION(
        "string::unicode::countSurrogatePairs and "
        "string::unicode::countCodepoints") {
        REQUIRE(countSurrogatePairs(tetragram) == 1);
        REQUIRE(countSurrogatePairs(television) == 0);

        REQUIRE(countCodepoints(tetragram) == 1);
        REQUIRE(countCodepoints(television) == 2);

        // It should start but not end with surrogate pairs
        auto string = buildTestString();
        REQUIRE(isSurrogatePair(string.substr(0, 2)));
        REQUIRE_FALSE(isSurrogatePair(string.substr(string.length() - 2)));

        // We should find 20 surrogate pairs
        auto expectedSurrogatePairCount = repeatedRunsInTestString;
        REQUIRE(countSurrogatePairs(string) == expectedSurrogatePairCount);

        // That should mean we have (length - surrogate pairs) codepoints
        REQUIRE(countCodepoints(string) ==
                string.length() - expectedSurrogatePairCount);

        // Add another surrogate pair, which will test the "final codepoint is
        // surrogate pair" case
        string += tetragram;
        REQUIRE(isSurrogatePair(string.substr(string.length() - 2)));
        ++expectedSurrogatePairCount;

        // Final checks
        REQUIRE(countSurrogatePairs(string) == expectedSurrogatePairCount);
        REQUIRE(countCodepoints(string) ==
                string.length() - expectedSurrogatePairCount);
    }

    SECTION("string::unicode::advanceByCodepoints") {
        const auto string = buildTestString();

        // Advance each time by the number of codepoints in each
        // surrogatePairInterval of our test string
        const auto testStringRepeatedRunLength =
            string.length() / repeatedRunsInTestString;
        const auto testStringRepeatedRun =
            string.substr(0, testStringRepeatedRunLength);
        const auto codepointsInRepeatedRun =
            countCodepoints(testStringRepeatedRun);

        size_t offset = {};
        size_t iterationCount = {};
        while (offset < string.length()) {
            // Advance by 5 codepoints
            const size_t newOffset =
                advanceByCodepoints(string, offset, codepointsInRepeatedRun);

            // Should not have advanced past end
            REQUIRE(newOffset <= string.length());

            // We should be skipping one character each iteration
            REQUIRE(newOffset - offset > codepointsInRepeatedRun);
            REQUIRE(newOffset == offset + testStringRepeatedRun.length());

            // Verify number of codepoints in the advanced-past region;
            // countCodepoints will also double-check for surrogate pair slicing
            REQUIRE(
                countCodepoints(string.substr(offset, newOffset - offset)) ==
                codepointsInRepeatedRun);

            // Update counter and offset
            ++iterationCount;
            offset = newOffset;
        }

        // We should have iterated 20 times
        REQUIRE(iterationCount == repeatedRunsInTestString);
    }
}
