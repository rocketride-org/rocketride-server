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

#pragma once
namespace ap::string::unicode {

// Functions for addressing UTF-8 by UTF-16 or UTF-32 characters
namespace utf8 {

inline auto isValidUtf8(TextView str) noexcept {
    if (!str) return false;
    return ::utf8::is_valid(str.begin(), str.end());
}

// Get number of UTF-16 characters required to encode UTF-32 character
_const inline size_t utf16Length(Utf32Chr ch) noexcept {
    // Is it a UTF-16 surrogate pair, i.e. does it require 2 UTF-16 characters
    // to represent?
    if (ch > 0xffff) return 2;
    return 1;
}

// Helper method for getting both lengths at once
_const inline UtfChars utfLengths(Utf32Chr ch) noexcept {
    return UtfChars{.utf16Chars = utf16Length(ch), .utf32Chars = 1};
}

// Calculate length of UTF-16 and UTF-32 strings from UTF-8 string
inline UtfChars utfLengths(TextView string) noexcept {
    UtfChars lengths;

    auto it = string.begin();
    const auto end = string.end();
    while (it < end) {
        // Get the current UTF-32 character and advance to the next
        const char32_t ch = ::utf8::unchecked::next(it);

        lengths.utf16Chars += utf16Length(ch);
        ++lengths.utf32Chars;
    }

    // utf8::unchecked may increment the string iterator past the end of the
    // string if the UTF-8 string is invalid
    if (it > end)
        dev::fatality(
            _location,
            APERR(Ec::InvalidParam,
                  "Walked past the end of an invalid UTF-8 string:", string));

    return lengths;
}

inline auto utf16Length(TextView string) noexcept {
    return utfLengths(string).utf16Chars;
}

inline auto utf32Length(TextView string) noexcept {
    return utfLengths(string).utf32Chars;
}

enum class SubstrMode { Utf16, Utf32 };

// Get substring of UTF-8 string based on either UTF-16 or 32 offset (indicated
// by mode) and return UTF-8, 16, and 32 offsets of the substring and UTF-16 and
// 32 lengths of substring
template <SubstrMode ModeT>
inline ErrorOr<TextView> utfSubstr(TextView string, size_t modeOffset,
                                   size_t modeLength, UtfCharsEx& substrOffsets,
                                   UtfChars& substrLengths) noexcept {
    // Checking length for 0 here simplifies the loop below
    if (!modeLength) return TextView();

    // Clear offsets and lengths
    substrOffsets = {};
    substrLengths = {};

    // Reference to the length and offset we care about
    auto& currentModeOffset = ModeT == SubstrMode::Utf16
                                  ? substrOffsets.utf16Chars
                                  : substrOffsets.utf32Chars;
    auto& currentModeLength = ModeT == SubstrMode::Utf16
                                  ? substrLengths.utf16Chars
                                  : substrLengths.utf32Chars;

    // UTF-8 iterators
    auto it = string.begin();
    const auto end = string.end();

    // Find the start off the substring
    while (it < end && currentModeOffset < modeOffset) {
        auto last = it;

        // Get UTF-32 character at the current UTF-8 offset and advance to the
        // next
        const char32_t utf32Chr = ::utf8::unchecked::next(it);

        // Advance by counts of UTF-16 and UTF-32 characters (always one,
        // obviously) from the UTF-32 character
        substrOffsets += utfLengths(utf32Chr);
        substrOffsets.utf8Chars += (it - last);
    }

    // Offset was too short
    if (it == end) return TextView();

    // If we've passed the offset without finding it exactly, the offset is
    // invalid
    if (currentModeOffset > modeOffset)
        APERR(Ec::InvalidParam, "Offset is invalid for UTF-8 string",
              modeOffset, string);

    // Start of UTF-8 substring
    const auto utf8SubstrStart = it;

    // Find the end of the substring
    while (it < end && currentModeLength < modeLength) {
        // Get UTF-32 character at the current UTF-8 offset and advance to the
        // next
        const char32_t utf32Chr = ::utf8::unchecked::next(it);

        // Advance by counts of UTF-16 and UTF-32 characters (always one,
        // obviously) from the UTF-32 character
        substrLengths += utfLengths(utf32Chr);
    }

    // utf8::unchecked may increment the string iterator past the end of the
    // string if the UTF-8 string is invalid
    if (it > end)
        dev::fatality(_location,
                      APERR(Ec::InvalidParam,
                            "Walked past the end of an invalid UTF-8 string",
                            string, modeOffset, modeLength));

    // We found the complete substring or length too short
    if (currentModeLength == modeLength || it == end)
        return TextView(utf8SubstrStart, it);

    // Otherwise, we didn't find the length exactly, which means it's invalid
    return APERR(Ec::InvalidParam, "Length is invalid for UTF-8 string",
                 currentModeLength, string);
}

inline ErrorOr<TextView> utf16Substr(TextView string, size_t offset,
                                     size_t length, UtfCharsEx& substrOffsets,
                                     UtfChars& substrLengths) noexcept {
    return utfSubstr<SubstrMode::Utf16>(string, offset, length, substrOffsets,
                                        substrLengths);
}

inline ErrorOr<TextView> utf32Substr(TextView string, size_t offset,
                                     size_t length, UtfCharsEx& substrOffsets,
                                     UtfChars& substrLengths) noexcept {
    return utfSubstr<SubstrMode::Utf32>(string, offset, length, substrOffsets,
                                        substrLengths);
}

template <typename ChrT>
inline ErrorOr<TextView> utfSubstr(TextView string, size_t offset,
                                   size_t length, UtfCharsEx& substrOffsets,
                                   UtfChars& substrLengths) noexcept {
    static_assert(
        sizeof(ChrT) == sizeof(Utf16Chr) || sizeof(ChrT) == sizeof(Utf32Chr),
        "Not supported");
    if constexpr (sizeof(ChrT) == sizeof(Utf16Chr))
        return utf16Substr(string, offset, length, substrOffsets,
                           substrLengths);
    else if constexpr (sizeof(ChrT) == sizeof(Utf32Chr))
        return utf32Substr(string, offset, length, substrOffsets,
                           substrLengths);
    // How'd you get here?
}

}  // namespace utf8

// Functions for addressing UTF-16 by UTF-32 chars
namespace utf16 {

_const bool isHighSurrogate(Utf16Chr chr) noexcept {
    return (chr >= HighSurrogateStart) && (chr <= HighSurrogateEnd);
}

_const bool isLowSurrogate(Utf16Chr chr) noexcept {
    return (chr >= LowSurrogateStart) && (chr <= LowSurrogateEnd);
}

_const bool isSurrogatePair(Utf16Chr hs, Utf16Chr ls) noexcept {
    return isHighSurrogate(hs) && isLowSurrogate(ls);
}

_const bool isSurrogatePair(Utf16View string) noexcept {
    return string.length() == 2 && isSurrogatePair(string[0], string[1]);
}

// Count the surrogate pairs in a UTF-16 string
inline size_t countSurrogatePairs(Utf16View string) noexcept {
    // Checking this up front simplifies the loop logic
    if (!string) return {};

    // Stop checking for surrogate pairs at (end - 1)
    const auto indexOfLastPossibleSurrogatePair = string.length() - 1;

    size_t surrogatePairCount = {};
    for (size_t i = 0; i < indexOfLastPossibleSurrogatePair; ++i) {
        if (isSurrogatePair(string[i], string[i + 1])) {
            ++surrogatePairCount;
            // Skip the low surrogate
            ++i;
        }
    }
    return surrogatePairCount;
}

// Count the codepoints in a UTF-16 string
inline size_t countCodepoints(Utf16View string) noexcept {
    const auto surroagatePairCount = countSurrogatePairs(string);
    // The number of codepoints encoded in a UTF-16 string is the number of
    // characters less the number of surrogate pairs, since each surrogate pair
    // is a single codepoint
    ASSERT(string.length() >= surroagatePairCount);
    return string.length() - surroagatePairCount;
}

// Starting at an offset, walk forward the indicated number of codepoints
// (surrogate pairs are a single codepoint encoded as two UTF-16 characters) and
// return the new offset
inline size_t advanceByCodepoints(Utf16View string, size_t offset,
                                  size_t distance) noexcept {
    // Checking this up front simplifies the loop logic
    if (!string || !distance) return {};

    // Debug-only checks
    ASSERT_MSG(offset != string.length(), "Infinite loop detected");
    ASSERT_MSG(offset < string.length(),
               "Trying to iterate past the end of a UTF-16 string", offset,
               string.length());

    // In release builds, the above checks are skipped; just return the length
    // of the string if the range is invalid
    if (offset >= string.length()) return string.length();

    // Check that the first character of the range isn't a sliced surrogate pair
    ASSERT_MSG(!isLowSurrogate(string[offset]),
               "Surrogate pair sliced during iteration", string);

    // Stop checking for surrogate pairs at (end - 1)
    const auto indexOfLastPossibleSurrogatePair = string.length() - 1;

    // Starting from the offset, count codepoints until we reach the desired
    // number
    for (size_t codepoints = {};
         offset < string.length() && codepoints < distance;
         ++offset, ++codepoints) {
        if (offset < indexOfLastPossibleSurrogatePair &&
            isSurrogatePair(string[offset], string[offset + 1])) {
            // Skip the low surrogate
            ++offset;
        }
    }

    // Sanity check
    ASSERT(offset <= string.length());

    // If we didn't reach the end, check that the final character of the
    // iterated range isn't a sliced surrogate pair
    ASSERT_MSG(
        offset == string.length() || !isHighSurrogate(string[offset - 1]),
        "Surrogate pair sliced during iteration", string);

    // Return advanced offset
    return offset;
}

// For UTF-32, characters and Unicode codepoints are identical, i.e. there is no
// encoding of codepoints as in UTF-8 and UTF-16.  Alias the codepoint API
// functions as their UTF-32 equivalents to make it easier for the caller to
// indicate which units they're concerned with.
inline auto utf32Length(Utf16View string) noexcept {
    return countCodepoints(string);
}

const auto advanceByUtf32Chars = advanceByCodepoints;

// Note that UTF-32 is technically a 31-bit encoding of the 32-bit UCS-4.
// However, since defining UTF-32, the Unicode standard has been updated to
// explicitly prohibit Unicode codepoints greater than U+10FFFF.  This means
// that UTF-32 and UCS-4 are functionally identical and can both represent all
// possible Unicode codepoints. See https://en.wikipedia.org/wiki/UTF-32

inline UtfChars utfLengths(Utf16View utf16) noexcept {
    return UtfChars{.utf16Chars = utf16.length(),
                    .utf32Chars = utf32Length(utf16)};
}

namespace test {

// Also gets UTF-8 length of UTF-16 string; inefficient, use only for
// unit-testing
inline UtfCharsEx utfLengthsEx(Utf16View utf16) noexcept {
    UtfCharsEx res;
    _cast<UtfChars&>(res) = utfLengths(utf16);
    res.utf8Chars = _tr<Text>(utf16).length();
    return res;
}

}  // namespace test

}  // namespace utf16

// Import utf8 and utf16 namespaces into the unicode namespace
using namespace utf8;
using namespace utf16;

}  // namespace ap::string::unicode
