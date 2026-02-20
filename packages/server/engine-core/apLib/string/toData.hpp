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

template <typename ChrT, typename TraitsT, typename AllocT, typename In>
inline void __fromData(Str<ChrT, TraitsT, AllocT>& str,
                       const In& in) noexcept(false) {
    auto byteSize = _fd<memory::PackHdr>(in)->size;

    // Strings are always encoded in utf8 when packed
    if constexpr (sizeof(ChrT) == sizeof(Utf8Chr)) {
        str.resize(byteSize);
        in.read({_reCast<uint8_t*>(str.data()), byteSize});
    } else {
        // Gotta convert it, do it on the stack
        StackTextArena arena;
        StackText utf8Str{arena};
        utf8Str.resize(byteSize);

        in.read({_reCast<uint8_t*>(utf8Str.data()), byteSize});

        __transform(utf8Str, str);
    }
}

template <typename ChrT, typename TraitsT, typename AllocT, typename Out>
inline void __toData(const Str<ChrT, TraitsT, AllocT>& str,
                     Out& out) noexcept(false) {
    // Strings are always encoded in utf8 when packed
    if constexpr (sizeof(ChrT) == sizeof(Utf8Chr)) {
        auto byteSize = str.size();
        out.write(viewCast(memory::PackHdr(byteSize)));
        out.write({_reCast<const uint8_t*>(str.data()), byteSize});
    } else {
        // Gotta convert it, do it on the stack
        StackTextArena arena;
        StackText utf8Str{arena};
        __transform(str, utf8Str);

        // Recurse
        __toData(utf8Str, out);
    }
}

}  // namespace ap::string