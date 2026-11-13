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

//
//	Transformations for character encoding types
//
#pragma once

namespace ap::string {

// Convert type to same type, stub method for generic coding
template <typename ChrT, typename TraitsT, typename AllocatorT>
inline void __transform(StrView<ChrT, TraitsT> source,
                        Str<ChrT, TraitsT, AllocatorT> &result) noexcept {
    result = source;
}

// Utf16 => Utf8
template <typename TraitsT, typename AllocatorT>
inline void __transform(Utf16View source,
                        Str<Utf8Chr, TraitsT, AllocatorT> &result) noexcept {
    // Ensure we clear the destination, always
    result.resize(0);

    if (source.empty()) return;

    // And convert
    utf8::unchecked::utf16to8(source.begin(), source.end(),
                              std::back_inserter(result));
}

template <typename TraitsT, typename AllocatorT>
inline void __transform(Utf32View source,
                        Str<Utf8Chr, TraitsT, AllocatorT> &result) noexcept {
    // Ensure we clear the destination, always
    result.resize(0);

    if (source.empty()) return;

    // And convert
    utf8::unchecked::utf32to8(source.begin(), source.end(),
                              std::back_inserter(result));
}

// Utf8 => Utf16
template <typename TraitsT, typename AllocatorT>
inline void __transform(Utf8View source,
                        Str<Utf16Chr, TraitsT, AllocatorT> &result) noexcept {
    // Ensure we clear the destination, always
    result.resize(0);

    // And convert
    utf8::unchecked::utf8to16(source.begin(), source.end(),
                              std::back_inserter(result));
}

template <typename TraitsT, typename AllocatorT>
inline void __transform(Utf32View source,
                        Str<Utf16Chr, TraitsT, AllocatorT> &result) noexcept {
    const size_t max_len = 2 * source.length() + 1;

    // Ensure we clear the destination, always
    result.resize(0);
    result.reserve(max_len);

    for (const auto &chr : source) {
        if (chr < 0 || chr > 0x10FFFF || (chr >= 0xD800 && chr <= 0xDFFF)) {
            // Invalid code point.  Replace with sentinel, per Unicode standard:
            constexpr Utf16Chr sentinel = u'\uFFFD';
            result.push_back(sentinel);
        } else if (chr < 0x10000UL) {  // In the BMP.
            result.push_back(static_cast<Utf16Chr>(chr));
        } else {
            const Utf16Chr leading =
                static_cast<Utf16Chr>(((chr - 0x10000UL) / 0x400U) + 0xD800U);
            const Utf16Chr trailing =
                static_cast<Utf16Chr>(((chr - 0x10000UL) % 0x400U) + 0xDC00U);

            result += leading;
            result += trailing;
        }
    }

    result.shrink_to_fit();
}

template <typename TraitsT, typename AllocatorT>
inline void __transform(Utf16View source,
                        Str<Utf32Chr, TraitsT, AllocatorT> &result) noexcept {
    const size_t max_len = source.length() + 1;

    // Ensure we clear the destination, always
    result.resize(0);
    result.reserve(max_len);

    // Clear the accumulator
    Utf32Chr utf32chr = 0;

    for (const auto &cp : source) {
        // If this is a high surrogate, save its value into the chr, waiting for
        // the next chr to come in
        if (ap::string::unicode::isHighSurrogate(cp)) {
            utf32chr = static_cast<Utf32Chr>((cp & 0x3FF) << 10);
            continue;
        }

        // If this is a low surrogate
        if (ap::string::unicode::isLowSurrogate(cp)) {
            // If we didn't get a hi one, ifnore this
            if (!utf32chr) continue;

            // Or the low one into the high one and add the
            // surrogate base
            utf32chr = utf32chr + static_cast<Utf32Chr>(cp & 0x3FF) + 0x10000;
        } else {
            // Not a surrogate, so use as it
            utf32chr = cp;
        }

        // Save the chr
        result.push_back(utf32chr);

        // Clear it in case we get a bad lo surrogate off the bat
        utf32chr = 0;
    }

    result.shrink_to_fit();
}

template <typename TraitsT, typename AllocatorT>
inline void __transform(Utf8View source,
                        Str<Utf32Chr, TraitsT, AllocatorT> &result) noexcept {
    Utf16 _result;

    // 8 -> 16
    __transform(source, _result);

    // 16 -> 32
    __transform(_result, result);
}

template <typename LTraitsT, typename LAllocatorT, typename RTraitsT,
          typename RAllocatorT>
inline void __transform(std::basic_string<char, LTraitsT, LAllocatorT> source,
                        Str<Utf8Chr, RTraitsT, RAllocatorT> &result) noexcept {
    result = {source.data(), source.size()};
}

template <typename T, typename = std::enable_if<std::is_arithmetic_v<T>>>
inline void __transform(TextView source, T &num) noexcept {
    num = _fs<T>(source);
}

}  // namespace ap::string
