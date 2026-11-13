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

// Concatenate chr + view = str
template <typename ChrT, typename TraitsT>
inline Str<ChrT, TraitsT> operator+(ChrT chr,
                                    StrView<ChrT, TraitsT> view) noexcept {
    Str<ChrT, TraitsT> res;
    return res.append(chr).append(view);
}

// Concatenate chr ptr + view = str
template <typename ChrT, typename TraitsT>
inline Str<ChrT, TraitsT> operator+(const ChrT *chr,
                                    StrView<ChrT, TraitsT> view) noexcept {
    Str<ChrT, TraitsT> res;
    return res.append(chr).append(view);
}

// Concatenate view + ptr = str
template <typename ChrT, typename TraitsT>
inline Str<ChrT, TraitsT> operator+(StrView<ChrT, TraitsT> view,
                                    const ChrT *str) noexcept {
    Str<ChrT, TraitsT> result = view;
    return result += str;
}

// Concatenate view + view = str
template <typename LChrT, typename LTraitsT, typename RChrT, typename RTraitsT>
inline Str<LChrT, LTraitsT> operator+(StrView<LChrT, LTraitsT> lhs,
                                      StrView<RChrT, RTraitsT> rhs) noexcept {
    Str<LChrT, LTraitsT> result = lhs;
    return result += rhs;
}

// Allow equality comparison to string ptr of our character type
// Assumes ptr is null terminated
template <typename ChrT, typename TraitsT>
_const bool operator==(StrView<ChrT, TraitsT> view, const ChrT *str) noexcept {
    if (!str) return false;
    return view.compare(str) == 0;
}

template <typename ChrT, typename TraitsT>
_const bool operator==(const ChrT *str, StrView<ChrT, TraitsT> view) noexcept {
    if (!str) return false;
    return view.compare(str) == 0;
}

// Allow inequality comparison to string ptr of our character type
// Assumes ptr is null terminated
template <typename ChrT, typename TraitsT>
_const bool operator!=(StrView<ChrT, TraitsT> view, const ChrT *str) noexcept {
    return !(operator==(view, str));
}

template <typename ChrT, typename TraitsT>
_const bool operator!=(const ChrT *str, StrView<ChrT, TraitsT> view) noexcept {
    return !(operator==(view, str));
}

}  // namespace ap::string
