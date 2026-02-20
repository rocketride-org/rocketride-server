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

#pragma once

namespace ap {

// Convert from Text to icu::StringPiece
inline void __transform(const TextView& source,
                        string::icu::StringPiece& piece) noexcept {
    piece.set(source.data(), _nc<int32_t>(source.size()));
}

// Convert from TextView to icu::StringPiece
inline void __transform(const Text& source,
                        string::icu::StringPiece& piece) noexcept {
    piece.set(source.data(), _nc<int32_t>(source.size()));
}

// Convert from TextView to icu::UnicodeString
inline void __transform(const TextView& source,
                        string::icu::UnicodeString& string) noexcept {
    string = string::icu::UnicodeString::fromUTF8(
        _tr<string::icu::StringPiece>(source));
}

// Convert from Text to icu::UnicodeString
inline void __transform(const Text& source,
                        string::icu::UnicodeString& string) noexcept {
    string = string::icu::UnicodeString::fromUTF8(
        _tr<string::icu::StringPiece>(source));
}

// Convert from icu::UnicodeString to Text
inline void __transform(const string::icu::UnicodeString& source,
                        Text& text) noexcept {
    text = string::icu::toUtf8(source);
}

// Convert from Utf16View to icu::UnicodeString
inline void __transform(const Utf16View& source,
                        string::icu::UnicodeString& string) noexcept {
    string.setTo(_reCast<const char16_t*>(source.data()),
                 _nc<int32_t>(source.size()));
}

// Convert from Utf16 to icu::UnicodeString
inline void __transform(const Utf16& source,
                        string::icu::UnicodeString& string) noexcept {
    string.setTo(_reCast<const char16_t*>(source.data()),
                 _nc<int32_t>(source.size()));
}

// Convert from icu::UnicodeString to Utf16View
inline void __transform(const string::icu::UnicodeString& source,
                        Utf16View& text) noexcept {
    text = Utf16View(_reCast<const Utf16Chr*>(source.getBuffer()),
                     source.length());
}

// Convert from icu::UnicodeString to Utf16
inline void __transform(const string::icu::UnicodeString& source,
                        Utf16& text) noexcept {
    text = string::icu::toUtf16(source);
}

// Convert from Utf32View to icu::UnicodeString
inline void __transform(const Utf32View& source,
                        string::icu::UnicodeString& string) noexcept {
    string = string::icu::UnicodeString::fromUTF32(
        _reCast<const UChar32*>(source.data()), _nc<int32_t>(source.size()));
}

}  // namespace ap