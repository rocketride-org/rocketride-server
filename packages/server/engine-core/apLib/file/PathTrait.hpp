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
//	Path trait used for path strings
//
#pragma once

namespace ap::file {

// The path trait properly sorts strings holding paths in path order
template <typename ChrT, template <typename ChrTT> typename ChrTraitsT>
struct PathTrait : public ChrTraitsT<ChrT> {
    using Parent = ChrTraitsT<ChrT>;

    // Compare two names. This fixes the subtle bug where a directory
    // in a path is compared incorrectly. This goes along with pathcmp.
    static int comparePath(const ChrT *lhs, const ChrT *rhs,
                           size_t len) noexcept {
        ChrT c1 = {}, c2 = {};

        auto comp1 = memory::DataView{lhs, len};
        auto comp2 = memory::DataView{rhs, len};

        // While we have characters to compare
        auto p1 = comp1.begin();
        auto p2 = comp2.begin();
        _forever() {
            // Get the characters
            if (p1 == comp1.end() || !*p1)
                c1 = {};
            else
                c1 = *p1;

            if (p2 == comp2.end() || !*p2)
                c2 = {};
            else
                c2 = *p2;

            // If we hit end of string on either of them, stop
            if (!c1 || !c2) break;

            // If c1 and c2 are the same, advance and continue on
            if (Parent::eq(c1, c2)) {
                if (p1 != comp1.end()) p1++;
                if (p2 != comp2.end()) p2++;
                continue;
            }

            // Now, the tricky part -
            // If c1 is a /, we know c2 is not, so c1 < c2
            // If c2 is a /, we know c1 is not, so c2 > c1
            if (isSep(c1)) return -1;
            if (isSep(c2)) return 1;

            // Now, they are different, so break out and use the subtractionn
            // below
            break;
        }

        // One of them has been exhausted, subtract for the difference
        return c1 - c2;
    }

    static auto eq(ChrT c1, ChrT c2) noexcept {
        return comparePath(&c1, &c2, 1) == 0;
    }

    static auto ne(ChrT c1, ChrT c2) noexcept {
        return comparePath(&c1, &c2, 1) != 0;
    }

    static auto lt(ChrT c1, ChrT c2) noexcept {
        return comparePath(&c1, &c2, 1) < 0;
    }

    static auto cmp(ChrT c1, ChrT c2) noexcept {
        return comparePath(&c1, &c2, 1);
    }

    static auto compare(const ChrT *s1, const ChrT *s2, size_t n) noexcept {
        return comparePath(s1, s2, n);
    }

    static const ChrT *find(const ChrT *s, size_t n, ChrT a) noexcept {
        while (n-- > 0) {
            if (eq(*s, a)) return s;
            ++s;
        }

        return nullptr;
    }
};

}  // namespace ap::file
