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

namespace ap::string {

namespace {

template <typename Arg, typename BufferType>
inline auto unpack(BufferType &&buffer, Arg &arg, FormatOptions opts) noexcept
    -> traits::IfPackAdapter<BufferType, Error> {
    return internal::unpackSelector(arg, opts, buffer);
}

template <typename Arg, typename BufferType>
inline auto unpack(BufferType &&buffer, Arg &arg, FormatOptions opts) noexcept
    -> traits::IfNotPackAdapter<BufferType, ErrorOr<Arg>> {
    if constexpr (std::is_constructible_v<TextView, BufferType>) {
        TextView view{buffer};
        PackAdapter adapter{view, BegPos};
        return unpack(adapter, arg, opts);
    } else if constexpr (std::is_constructible_v<Utf16View, BufferType>) {
        Utf16View view{buffer};
        PackAdapter adapter{view, BegPos};
        return unpack(adapter, arg, opts);
    } else {
        PackAdapter adapter{buffer, BegPos};
        return unpack(adapter, arg, opts);
    }
}

}  // namespace

// Converts a type from a string
template <typename Arg, typename BufferType>
inline ErrorOr<Arg> fromStringEx(const BufferType &buffer,
                                 FormatOptions opts) noexcept {
    static_assert(std::is_default_constructible_v<Arg>,
                  "Cannot perform from string on objects which cannot be "
                  "default constructed");

    Arg arg;

    if constexpr (traits::IsPackAdapterV<BufferType>) {
        if (auto ccode = unpack(buffer, arg, opts)) {
            ASSERTD_MSG(!opts.noFail(), "Failed to parse type from string '",
                        buffer, "':", ccode);
            return ccode;
        }
    } else {
        if (auto res = unpack(buffer, arg, opts); res.hasCcode()) {
            ASSERTD_MSG(!opts.noFail(), "Failed to parse type from string '",
                        buffer, "':", res.ccode());
            return res.ccode();
        }
    }

    return arg;
}

}  // namespace ap::string
