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

#include "test.h"

TEST_CASE("traits") {
    using namespace traits;

    SECTION("IsSameType") {
        static_assert(IsSameTypeV<const char*, char*>);
        static_assert(IsSameTypeV<char const*, char*>);
        static_assert(IsSameTypeV<char* const, char*>);

        static_assert(IsSameTypeV<char*, const char*>);
        static_assert(IsSameTypeV<char*, char const*>);
        static_assert(IsSameTypeV<char*, char* const>);
    }

    SECTION("HasElementType") {
        static_assert(HasElementTypeV<std::unique_ptr<int>>);
        static_assert(HasElementTypeV<ErrorOr<int>>);
        static_assert(HasElementTypeV<ErrorOr<std::unique_ptr<int>>>);
        static_assert(HasElementTypeV<ErrorOr<Ptr<int>>>);
    }

    SECTION("IsContiguousContainer") {
        static_assert(IsContiguousContainerV<std::vector<char>>);
        static_assert(IsContiguousContainerV<Text>);
        static_assert(IsContiguousContainerV<Utf16>);
        static_assert(IsContiguousContainerV<std::string>);
        static_assert(IsContiguousContainerV<std::string_view>);
        static_assert(IsContiguousContainerV<TextView>);
        static_assert(IsContiguousContainerV<Utf16View>);

        static_assert(!IsContiguousContainerV<std::list<int>>);
        static_assert(!IsContiguousContainerV<std::map<int, int>>);
        static_assert(!IsContiguousContainerV<std::unordered_map<int, int>>);
        static_assert(!IsContiguousContainerV<std::set<int>>);
    }

    SECTION("IsContiguousPodContainer") {
        static_assert(IsContiguousPodContainer<std::vector<char>>());
        static_assert(IsContiguousPodContainer<Text>());
        static_assert(IsContiguousPodContainer<Utf16>());
        static_assert(IsContiguousPodContainer<std::string>());
        static_assert(IsContiguousPodContainer<std::string_view>());
        static_assert(IsContiguousPodContainer<TextView>());
        static_assert(IsContiguousPodContainer<Utf16View>());

        static_assert(!IsContiguousPodContainer<std::list<int>>());
        static_assert(!IsContiguousPodContainer<std::map<int, int>>());
        static_assert(
            !IsContiguousPodContainer<std::unordered_map<int, int>>());
        static_assert(!IsContiguousPodContainer<std::set<int>>());
    }

    SECTION("IsOutputIterator") {
        //	static_assert(IsOutputIteratorV<std::back_insert_iterator<std::vector<char>>>);
    }
}
