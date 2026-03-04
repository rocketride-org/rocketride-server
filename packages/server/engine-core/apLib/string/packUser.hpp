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

namespace ap::string::internal {

// Method handlers
template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::UserNoFailMethod) noexcept {
    return _callChk([&] { arg.__toString(buff); });
}

template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::UserMayFailMethod) noexcept {
    return arg.__toString(buff);
}

template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::UserNoFailMethodOpts) noexcept {
    return _callChk([&] { arg.__toString(buff, opts); });
}

template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::UserMayFailMethodOpts) noexcept {
    return _callChk([&] { return arg.__toString(buff, opts); });
}

// Function handlers (adl)
template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::UserNoFailFunction) noexcept {
    return _callChk([&] { __toString(arg, buff); });
}

template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::UserMayFailFunction) noexcept {
    return _callChk([&] { return __toString(arg, buff); });
}

template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::UserNoFailFunctionOpts) noexcept {
    return _callChk([&] { __toString(arg, buff, opts); });
}

template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::UserMayFailFunctionOpts) noexcept {
    return _callChk([&] { return __toString(arg, buff, opts); });
}

}  // namespace ap::string::internal
