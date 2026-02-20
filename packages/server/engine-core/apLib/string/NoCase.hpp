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
//	Case insensitive character trait
//
#pragma once

namespace ap::string {

// Character trait that makes a string case un-aware allowing for use in
// sets and maps and other containers without requiring the set to use
// a custom comparator.
template <typename ChrT>
struct NoCase : public ::std::char_traits<ChrT> {
    static_assert(std::is_integral_v<ChrT>, "Invalid argument");

    // Define some constants to quickly lowercase A-Z
    _const auto LowerCaseBegin = ChrT('A');
    _const auto LowerCaseEnd = ChrT('Z');
    _const auto LowerCaseOffset = ChrT('a') - ChrT('A');

    _const ChrT toLower(ChrT c) noexcept {
        if (c > LowerCaseEnd) return c;
        if (c < LowerCaseBegin) return c;
        return c + LowerCaseOffset;
    }

    _const auto eq(ChrT c1, ChrT c2) noexcept {
        if (c1 == c2) return true;
        return toLower(c1) == toLower(c2);
    }

    _const auto ne(ChrT c1, ChrT c2) noexcept {
        if (c1 == c2) return false;
        return !eq(c1, c2);
    }

    _const auto lt(ChrT c1, ChrT c2) noexcept {
        if (c1 == c2) return 0;
        return toLower(c1) < toLower(c2);
    }

    _const auto cmp(ChrT c1, ChrT c2) noexcept {
        if (eq(c1, c2)) return 0;

        auto _c1 = toLower(c1);
        auto _c2 = toLower(c2);

        if (_c1 == _c2)
            return 0;
        else if (_c1 < _c2)
            return -1;

        return 1;
    }

    _const auto compare(const ChrT *s1, const ChrT *s2, size_t n) noexcept {
        while (n-- != 0) {
            if (auto res = cmp(*s1++, *s2++); res != 0) return res;
        }
        return 0;
    }

    _const ChrT *find(const ChrT *s, size_t n, ChrT a) noexcept {
        while (n-- > 0) {
            if (eq(*s, a)) return s;
            ++s;
        }

        return nullptr;
    }
};

}  // namespace ap::string
