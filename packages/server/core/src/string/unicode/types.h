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

// Byte order marks
_const auto Utf16LeBomAsUtf8 = "\xFF\xFE"_tv;
_const auto Utf16LeBom = _cast<Utf16Chr>(0xFEFF);
_const auto Utf16BeBomAsUtf8 = "\xFE\xFF"_tv;
_const auto Utf16BeBom = _cast<Utf16Chr>(0xFFFE);

_const auto Utf32LeBomAsUtf8 = "\xFF\xFE\x00\x00"_tv;
_const auto Utf32LeBom = _cast<Utf32Chr>(0x0000FEFF);
_const auto Utf32BeBomAsUtf8 = "\x00\x00\xFE\xFF"_tv;
_const auto Utf32BeBom = _cast<Utf32Chr>(0xFFFE0000);

_const auto Utf8Bom = "\xEF\xBB\xBF"_tv;

// Surrogate pair ranges
_const auto HighSurrogateStart = 0xd800;
_const auto HighSurrogateEnd = 0xdbff;
_const auto LowSurrogateStart = 0xdc00;
_const auto LowSurrogateEnd = 0xdfff;

// Counts of both UTF-16 and UTF-32 chars, used as either a length or an offset
struct UtfChars {
    size_t utf16Chars = {};
    size_t utf32Chars = {};

    constexpr bool equals(const UtfChars& other) const noexcept {
        return utf16Chars == other.utf16Chars && utf32Chars == other.utf32Chars;
    }

    constexpr bool operator==(const UtfChars& other) const noexcept {
        return equals(other);
    }

    constexpr bool operator!=(const UtfChars& other) const noexcept {
        return !equals(other);
    }

    // Prefix increment operator
    constexpr UtfChars& operator++() noexcept {
        ++utf16Chars;
        ++utf32Chars;
        return *this;
    }

    // Postfix increment operator
    constexpr UtfChars operator++(int) noexcept {
        auto res = *this;
        ++utf16Chars;
        ++utf32Chars;
        return res;
    }

    constexpr UtfChars& operator+=(const UtfChars& other) noexcept {
        utf16Chars += other.utf16Chars;
        utf32Chars += other.utf32Chars;
        return *this;
    }

    constexpr UtfChars operator+(const UtfChars& other) const noexcept {
        auto copy = *this;
        copy += other;
        return copy;
    }

    constexpr UtfChars& operator-=(const UtfChars& other) noexcept {
        ASSERTD(utf16Chars >= other.utf16Chars &&
                utf32Chars >= other.utf32Chars);
        utf16Chars -= other.utf16Chars;
        utf32Chars -= other.utf32Chars;
        return *this;
    }

    constexpr UtfChars operator-(const UtfChars& other) const noexcept {
        auto copy = *this;
        copy -= other;
        return copy;
    }
};

// Expanded version of UtfChars that count of UTF-8 characters
struct UtfCharsEx : public UtfChars {
    using Parent = UtfChars;

    size_t utf8Chars = {};

    UtfCharsEx() = default;

    // Can't use aggregate initialization due to having a base class
    UtfCharsEx(size_t _utf8Chars, size_t _utf16Chars, size_t _utf32Chars)
        : utf8Chars(_utf8Chars) {
        utf16Chars = _utf16Chars;
        utf32Chars = _utf32Chars;
    }

    UtfCharsEx(const UtfChars& utfChars, size_t _utf8Chars)
        : Parent(utfChars), utf8Chars(_utf8Chars) {}

    constexpr bool equals(const UtfCharsEx& other) const noexcept {
        return Parent::equals(other) && utf8Chars == other.utf8Chars;
    }

    constexpr bool operator==(const UtfCharsEx& other) const noexcept {
        return equals(other);
    }

    constexpr bool operator!=(const UtfCharsEx& other) const noexcept {
        return !equals(other);
    }
};

}  // namespace ap::string::unicode
