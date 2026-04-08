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

namespace ap::traits {

APTRAIT_DEF(PackAdapter, string::PackAdapter);

template <typename T, typename Y>
using IfPackAdapter = std::enable_if_t<IsPackAdapterV<T>, Y>;

template <typename T, typename Y>
using IfNotPackAdapter = std::enable_if_t<!IsPackAdapterV<T>, Y>;

// IterCategory
template <class Iterator>
using IteratorCategoryT =
    typename std::iterator_traits<Iterator>::iterator_category;

// IsAllocator
template <class T, class = void>
struct IsAllocator : std::false_type {};

template <class T>
struct IsAllocator<T, VoidType<typename T::value_type,
                               decltype(std::declval<T &>().deallocate(
                                   std::declval<T &>().allocate(std::size_t{1}),
                                   std::size_t{1}))>> : std::true_type {};

// Deduction guide
template <class Allocator>
using GuideSizeTypeT = typename std::allocator_traits<std::conditional_t<
    IsAllocator<Allocator>::value, Allocator, std::allocator<int>>>::size_type;

}  // namespace ap::traits
