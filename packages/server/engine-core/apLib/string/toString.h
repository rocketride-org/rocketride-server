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

//
// To string conversion apis
//
#pragma once

namespace ap::string {

// This is the core api all others use for string conversions, it returns
// errors, and accepts any
template <typename BufferType, typename... Args>
Error toStringEx(BufferType &buffer, FormatOptions options,
                 Args &&...args) noexcept;

template <typename BufferType, typename... Args>
auto toStringBufferOptions(BufferType &buffer, FormatOptions options,
                           Args &&...args) noexcept {
    return toStringEx(buffer, options, std::forward<Args>(args)...);
}

template <typename BufferType, typename... Args>
auto toStringBuffer(BufferType &buffer, Args &&...args) noexcept {
    return toStringEx(buffer, Format::NOFAIL, std::forward<Args>(args)...);
}

// Direct conversion to Text apis
template <typename... Args>
inline auto toStringOptions(FormatOptions options, Args &&...args) noexcept {
    Text result;
    toStringEx(result, options + Format::NOFAIL, std::forward<Args>(args)...);
    return result;
}

template <typename... Args>
inline auto toString(Args &&...args) noexcept {
    Text result;
    toStringEx<Text>(result, Format::NOFAIL, std::forward<Args>(args)...);
    return result;
}

template <char Delimiter = ' ', uint32_t Flags = Format::DefFlags,
          typename... Args>
inline auto toStringDelimited(Args &&...args) noexcept {
    Text result;
    toStringEx(result, {Format::NOFAIL | Flags, Format::DefWidth, Delimiter},
               std::forward<Args>(args)...);
    return result;
}

template <typename BufferType, char Delimiter = ' ',
          uint32_t Flags = Format::DefFlags, typename... Args>
auto toStringBufferDelimited(BufferType &buffer, Args &&...args) noexcept {
    return toStringBufferOptions(
        buffer, {Format::NOFAIL | Flags, Format::DefWidth, Delimiter},
        std::forward<Args>(args)...);
}

}  // namespace ap::string

#define _ts ::ap::string::toString
#define _tso ::ap::string::toStringOptions
#define _tsb ::ap::string::toStringBuffer
#define _tsbo ::ap::string::toStringBufferOptions
#define _tsd ::ap::string::toStringDelimited
#define _tsbd ::ap::string::toStringBufferDelimited
