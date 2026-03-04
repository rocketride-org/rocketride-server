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

TEST_CASE("string::unicode::utfSubstr") {
    using namespace string::unicode;

    // A surrogate pair, "tetragram for centre", U+1D306 (𝌆)
    const auto tetragram = u"\xd834\xdf06"_tv;

    // Hard-coded lengths for validation, since we'll be relying on the logic
    // below to calculate the substring offset
    const UtfCharsEx expectedTextLengths(43,  // utf8Chars
                                         23,  // utf16Chars
                                         13   // utf32Chars
    );

    // Build a UTF-8 string with 13 codepoints-- "cat" with 5x𝌆 on either side
    UtfCharsEx expectedSubstrOffsets;
    const Utf16 cat = u"cat";
    auto buildUtf16Text = [&] {
        Utf16 utf16Text;

        for (size_t i = 0; i < 4; ++i) {
            utf16Text += tetragram;
        }

        // This is where we'll start our substring
        expectedSubstrOffsets = utf16::test::utfLengthsEx(utf16Text);

        utf16Text += tetragram;
        utf16Text += cat;

        for (size_t i = 0; i < 5; ++i) {
            utf16Text += tetragram;
        }
        return utf16Text;
    };

    // Build and validate
    const auto utf16Text = buildUtf16Text();
    REQUIRE(utf16Text.length() == expectedTextLengths.utf16Chars);

    // Convert and validate
    const auto text = _tr<Text>(utf16Text);
    const auto lengths = utfLengths(text);
    REQUIRE(lengths == expectedTextLengths);

    // Same deal, but with the substring
    const UtfChars expectedSubstrLengths{.utf16Chars = 7, .utf32Chars = 5};

    // The expected substring match will be "𝌆cat𝌆"
    auto buildUtf16Substr = [&] {
        Utf16 utf16Substr;
        utf16Substr += tetragram;
        utf16Substr += cat;
        utf16Substr += tetragram;
        return utf16Substr;
    };

    const auto expectedUtf16Substr = buildUtf16Substr();
    REQUIRE(expectedUtf16Substr.length() == expectedSubstrLengths.utf16Chars);

    const auto expectedSubstr = _tr<Text>(expectedUtf16Substr);
    REQUIRE(isValidUtf8(text));
    REQUIRE(utfLengths(expectedSubstr) == expectedSubstrLengths);

    UtfCharsEx substrOffsets;
    UtfChars substrLengths;

    // Validate substring against expected
    auto validateSubstr = [&](TextView string, UtfCharsEx& offsets,
                              UtfChars& lengths) {
        REQUIRE(string == expectedSubstr);
        REQUIRE(offsets == expectedSubstrOffsets);
        REQUIRE(lengths == expectedSubstrLengths);
    };
    validateSubstr(
        *utfSubstr<SubstrMode::Utf16>(text, expectedSubstrOffsets.utf16Chars,
                                      expectedSubstrLengths.utf16Chars,
                                      substrOffsets, substrLengths),
        substrOffsets, substrLengths);
    validateSubstr(*utf16Substr(text, expectedSubstrOffsets.utf16Chars,
                                expectedSubstrLengths.utf16Chars, substrOffsets,
                                substrLengths),
                   substrOffsets, substrLengths);
    validateSubstr(*utfSubstr<Utf16Chr>(text, expectedSubstrOffsets.utf16Chars,
                                        expectedSubstrLengths.utf16Chars,
                                        substrOffsets, substrLengths),
                   substrOffsets, substrLengths);

    validateSubstr(
        *utfSubstr<SubstrMode::Utf32>(text, expectedSubstrOffsets.utf32Chars,
                                      expectedSubstrLengths.utf32Chars,
                                      substrOffsets, substrLengths),
        substrOffsets, substrLengths);
    validateSubstr(*utf32Substr(text, expectedSubstrOffsets.utf32Chars,
                                expectedSubstrLengths.utf32Chars, substrOffsets,
                                substrLengths),
                   substrOffsets, substrLengths);
    validateSubstr(*utfSubstr<Utf32Chr>(text, expectedSubstrOffsets.utf32Chars,
                                        expectedSubstrLengths.utf32Chars,
                                        substrOffsets, substrLengths),
                   substrOffsets, substrLengths);

    // Validate range of whole string
    auto validateText = [&](TextView string, UtfCharsEx& offsets,
                            UtfChars& lengths) {
        REQUIRE(string == text);
        REQUIRE(offsets == UtfCharsEx());
        REQUIRE(lengths == expectedTextLengths);
    };
    validateText(
        *utfSubstr<SubstrMode::Utf16>(text, 0, expectedTextLengths.utf16Chars,
                                      substrOffsets, substrLengths),
        substrOffsets, substrLengths);
    validateText(
        *utfSubstr<SubstrMode::Utf32>(text, 0, expectedTextLengths.utf32Chars,
                                      substrOffsets, substrLengths),
        substrOffsets, substrLengths);

    // Validate ranges from start to past end of string
    validateText(*utfSubstr<SubstrMode::Utf16>(
                     text, 0, expectedTextLengths.utf16Chars + 100,
                     substrOffsets, substrLengths),
                 substrOffsets, substrLengths);
    validateText(*utfSubstr<SubstrMode::Utf32>(
                     text, 0, expectedTextLengths.utf32Chars + 100,
                     substrOffsets, substrLengths),
                 substrOffsets, substrLengths);

    // Validate left
    const auto expectedLeft =
        _tr<Text>(utf16Text.substr(0, expectedSubstrOffsets.utf16Chars));
    auto validateLeft = [&](TextView string, UtfCharsEx& offsets,
                            UtfChars& lengths) {
        REQUIRE(string == expectedLeft);
        REQUIRE(offsets == UtfCharsEx());
        REQUIRE(lengths == expectedSubstrOffsets);
    };
    validateLeft(
        *utfSubstr<SubstrMode::Utf16>(text, 0, expectedSubstrOffsets.utf16Chars,
                                      substrOffsets, substrLengths),
        substrOffsets, substrLengths);
    validateLeft(
        *utfSubstr<SubstrMode::Utf32>(text, 0, expectedSubstrOffsets.utf32Chars,
                                      substrOffsets, substrLengths),
        substrOffsets, substrLengths);

    // Validate right
    const UtfCharsEx expectedRightOffsets(
        expectedSubstrOffsets + expectedSubstrLengths,
        expectedSubstrOffsets.utf8Chars + expectedSubstr.length());
    auto expectedRightLengths = expectedTextLengths - expectedRightOffsets;
    const auto expectedRight = _tr<Text>(utf16Text.substr(
        expectedRightOffsets.utf16Chars + expectedRightLengths.utf16Chars -
        expectedRightLengths.utf16Chars));
    auto valdateRight = [&](TextView string, UtfCharsEx& offsets,
                            UtfChars& lengths) {
        REQUIRE(string == expectedRight);
        REQUIRE(offsets == expectedRightOffsets);
        REQUIRE(lengths == expectedRightLengths);
    };
    valdateRight(
        *utfSubstr<SubstrMode::Utf16>(text, expectedRightOffsets.utf16Chars,
                                      expectedRightLengths.utf16Chars,
                                      substrOffsets, substrLengths),
        substrOffsets, substrLengths);
    valdateRight(
        *utfSubstr<SubstrMode::Utf32>(text, expectedRightOffsets.utf32Chars,
                                      expectedRightLengths.utf32Chars,
                                      substrOffsets, substrLengths),
        substrOffsets, substrLengths);

    // Validate ranges from right to past end of string
    valdateRight(
        *utfSubstr<SubstrMode::Utf16>(text, expectedRightOffsets.utf16Chars,
                                      expectedTextLengths.utf16Chars,
                                      substrOffsets, substrLengths),
        substrOffsets, substrLengths);
    valdateRight(
        *utfSubstr<SubstrMode::Utf32>(text, expectedRightOffsets.utf32Chars,
                                      expectedTextLengths.utf32Chars,
                                      substrOffsets, substrLengths),
        substrOffsets, substrLengths);

    // Validate unreachable ranges
    REQUIRE(*utfSubstr<SubstrMode::Utf16>(text, expectedTextLengths.utf16Chars,
                                          1000, substrOffsets,
                                          substrLengths) == "");
    REQUIRE(*utfSubstr<SubstrMode::Utf32>(text, expectedTextLengths.utf32Chars,
                                          1000, substrOffsets,
                                          substrLengths) == "");

    // Validate invalid UTF-16 ranges, i.e. split surrogate pairs (UTF-32 ranges
    // can't be invalid)
    REQUIRE_THROWS(*utfSubstr<SubstrMode::Utf16>(text, 0, 1, substrOffsets,
                                                 substrLengths));
    REQUIRE_THROWS(
        *utfSubstr<SubstrMode::Utf16>(text, expectedRightOffsets.utf16Chars, 1,
                                      substrOffsets, substrLengths));
}