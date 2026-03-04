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

namespace ap::log {

// log output apis:
// Prefix version take an arbitrary type and render it as a string to include
// in the decoration
template <typename Prefix, size_t MaxFields = Format::DefMaxFields,
          typename... Args>
void writeEx(const FormatOptions &options, Location location,
             Opt<Ref<const Prefix>> prefix,
             const string::FormatStr<MaxFields> &fmt, Args &&...args) noexcept;

template <typename Prefix, typename FmtT, typename... Args>
inline auto writePrefix(const FormatOptions &options, Location location,
                        const Prefix &prefix, const FmtT &fmtType,
                        Args &&...args) noexcept {
    // Allow a non string for the first arg
    if constexpr (std::is_convertible_v<FmtT, TextView>) {
        string::FormatStr<Format::DefMaxFields> fmt{fmtType};
        return writeEx<Prefix>(options, location, {prefix}, fmt,
                               std::forward<Args>(args)...);
    } else
        return writeEx<Prefix>(options, location, {prefix}, {}, fmtType,
                               std::forward<Args>(args)...);
}

template <typename Prefix, typename FmtT, typename... Args>
inline auto writePrefix(Location location, const Prefix &prefix,
                        const FmtT &fmtType, Args &&...args) noexcept {
    // Allow a non string for the first arg
    if constexpr (std::is_convertible_v<FmtT, TextView>) {
        string::FormatStr<Format::DefMaxFields> fmt{fmtType};
        return writeEx<Prefix>(FormatOptions{0, 0, ' '}, location, {prefix},
                               fmt, std::forward<Args>(args)...);
    } else
        return writeEx<Prefix>(FormatOptions{0, 0, ' '}, location, {prefix}, {},
                               std::forward<Args>(args)...);
}

template <size_t MaxFields = Format::DefMaxFields, typename FmtT,
          typename... Args>
auto write(FormatOptions fmtOptions, Location location, const FmtT &fmtType,
           Args &&...args) noexcept {
    // Allow a non string for the first arg
    if constexpr (std::is_convertible_v<FmtT, TextView>) {
        string::FormatStr<Format::DefMaxFields> fmt{fmtType};
        return writeEx<int>(fmtOptions, location, {}, fmt,
                            std::forward<Args>(args)...);
    } else
        return writeEx<int>(fmtOptions, location, {}, {}, fmtType,
                            std::forward<Args>(args)...);
}

template <typename FmtT, typename... Args>
inline auto write(Location location, const FmtT &fmtType,
                  Args &&...args) noexcept {
    // Allow a non string for the first arg
    if constexpr (std::is_convertible_v<FmtT, TextView>) {
        string::FormatStr<Format::DefMaxFields> fmt{fmtType};
        return writeEx<int>(FormatOptions{0, 0, ' '}, location, {}, fmt,
                            std::forward<Args>(args)...);
    } else
        return writeEx<int>(FormatOptions{0, 0, ' '}, location, {}, {}, fmtType,
                            std::forward<Args>(args)...);
}

}  // namespace ap::log
