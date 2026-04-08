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

namespace ap::string::icu {

// Convert from icu::UnicodeString to Text
template <typename TraitsT = Case<Utf8Chr>,
          typename AllocT = std::allocator<Utf8Chr>>
inline Str<Utf8Chr, TraitsT, AllocT> toUtf8(const UnicodeString &source,
                                            const AllocT &alloc = {}) noexcept {
    TextSink sink(alloc);
    source.toUTF8(sink);
    return _mv(sink.extract());
}

// Convert from icu::UnicodeString to Utf16
template <typename TraitsT = Case<Utf16Chr>,
          typename AllocT = std::allocator<Utf16Chr>>
inline Str<Utf16Chr, TraitsT, AllocT> toUtf16(
    const UnicodeString &source, const AllocT &alloc = {}) noexcept {
    return Str<Utf16Chr, TraitsT, AllocT>(
        _reCast<const Utf16Chr *>(source.getBuffer()), source.length(), alloc);
}

}  // namespace ap::string::icu