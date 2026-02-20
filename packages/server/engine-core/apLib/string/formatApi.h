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

namespace ap::string {

// Type safe prinft style formater api
template <size_t MaxFields = Format::DefMaxFields, typename BufferType,
          typename... Args>
Error formatEx(BufferType &result, FormatOptions options,
               const FormatStr<MaxFields> &fmt, Args &&...args) noexcept;

template <size_t MaxFields, typename... Args>
inline auto formatEx(const FormatStr<MaxFields> &fmt, Args &&...args) noexcept {
    Text result;
    formatEx(result, Format::NOFAIL, fmt, std::forward<Args>(args)...);
    return result;
}

template <size_t MaxFields = Format::DefMaxFields, typename BufferType,
          typename... Args>
inline auto formatBufferEx(BufferType &&result,
                           const FormatStr<MaxFields> &fmtStr,
                           Args &&...args) noexcept {
    return formatEx(std::forward<BufferType>(result), {}, fmtStr,
                    std::forward<Args>(args)...);
}

template <typename BufferType, typename... Args>
inline auto formatBuffer(BufferType &&result, TextView fmt,
                         Args &&...args) noexcept {
    FormatStr<> fmtStr = fmt;
    return formatEx(std::forward<BufferType>(result), {}, fmtStr,
                    std::forward<Args>(args)...);
}

template <typename... Args>
inline auto format(FormatOptions options, TextView fmt,
                   Args &&...args) noexcept {
    Text result;
    FormatStr<> fmtStr = fmt;
    formatEx<Format::DefMaxFields, Text>(result, options + Format::NOFAIL,
                                         fmtStr, std::forward<Args>(args)...);
    return result;
}

template <typename... Args>
inline auto format(TextView fmt, Args &&...args) noexcept {
    return format(FormatOptions{}, fmt, std::forward<Args>(args)...);
}

}  // namespace ap::string
