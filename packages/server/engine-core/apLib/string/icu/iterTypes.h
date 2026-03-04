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

// Alias some concrete types in the main string namespace
template <typename RuleSet, size_t MaxWordSize = 256,
          typename Allocator = std::allocator<Utf8Chr>>
using TextBoundaryIter =
    icu::BoundaryIterator<RuleSet, Utf8Chr, string::Case<Utf8Chr>, MaxWordSize,
                          Allocator>;

template <typename RuleSet, size_t MaxWordSize = 256,
          typename Allocator = std::allocator<Utf8Chr>>
using iTextBoundaryIter =
    icu::BoundaryIterator<RuleSet, Utf8Chr, string::NoCase<Utf8Chr>,
                          MaxWordSize, Allocator>;

template <typename RuleSet, size_t MaxWordSize = 256,
          typename Allocator = std::allocator<Utf16Chr>>
using Utf16BoundaryIter =
    icu::BoundaryIterator<RuleSet, Utf16Chr, string::Case<Utf16Chr>,
                          MaxWordSize, Allocator>;

template <typename RuleSet, size_t MaxWordSize = 256,
          typename Allocator = std::allocator<Utf16Chr>>
using iUtf16BoundaryIter =
    icu::BoundaryIterator<RuleSet, Utf16Chr, string::NoCase<Utf16Chr>,
                          MaxWordSize, Allocator>;

}  // namespace ap::string