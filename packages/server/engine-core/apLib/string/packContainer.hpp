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

namespace ap::string::internal {

template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::Container) noexcept {
    if constexpr (traits::IsTupleV<T>) {
        Error ccode;
        bool delim = false;
        _forEach(arg, [&](const auto &entry) noexcept {
            if (std::exchange(delim, true)) buff << opts.delimiter(' ');
            ccode = packSelector(entry, opts, buff) || ccode;
        });
        return ccode;
    } else if constexpr (traits::IsMapV<T>) {
        bool delim = false;
        for (auto &entry : arg) {
            if (std::exchange(delim, true)) buff << opts.delimiter(' ');
            if (auto ccode = packSelector(entry, opts.setDelimiter('='), buff);
                ccode)
                return ccode;
        }
        return {};
    } else {
        bool delim = false;
        for (auto &entry : arg) {
            if (std::exchange(delim, true)) buff << opts.delimiter(' ');
            if (auto ccode = packSelector(entry, opts, buff); ccode)
                return ccode;
        }
        return {};
    }
}

}  // namespace ap::string::internal
