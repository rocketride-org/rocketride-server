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
// From string conversion apis
//
#pragma once

namespace ap::string {

template <typename Arg, typename BufferType>
ErrorOr<Arg> fromStringEx(const BufferType &buffer,
                          FormatOptions options = {}) noexcept;

template <typename Arg, typename BufferType>
inline auto fromString(const BufferType &buffer,
                       FormatOptions options = {}) noexcept {
    return _mv(fromStringEx<Arg>(buffer, options + Format::NOFAIL).value());
}

template <typename Arg, typename BufferType>
inline auto fromStringOptions(const FormatOptions &options,
                              const BufferType &buffer) noexcept {
    return _mv(fromStringEx<Arg>(buffer, options + Format::NOFAIL).value());
}

// Simple wrappers for parsing hex strings, the most common use of
// fromStringOptions
template <typename Arg, typename BufferType>
ErrorOr<Arg> fromHexStringEx(const BufferType &buffer,
                             FormatOptions options = {}) noexcept {
    return fromStringEx<Arg>(buffer, options + Format::HEX);
}

template <typename Arg, typename BufferType>
inline auto fromHexString(const BufferType &buffer,
                          FormatOptions options = {}) noexcept {
    return fromStringOptions<Arg>(options + Format::HEX, buffer);
}

}  // namespace ap::string

// Some handy shorthand usage macros
#define _fs ::ap::string::fromString
#define _fso ::ap::string::fromStringOptions
#define _fsc ::ap::string::fromStringEx
#define _fsh ::ap::string::fromHexString
