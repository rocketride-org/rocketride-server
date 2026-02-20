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

namespace ap {
namespace memory {

_const size_t DefaultSmallSize = 1024;

template <typename T, size_t BufSize = DefaultSmallSize>
using SmallAllocator = ShortAllocator<T, BufSize, alignof(std::max_align_t)>;

template <typename T, std::size_t BufSize = DefaultSmallSize>
using SmallVector = std::vector<T, SmallAllocator<T, BufSize>>;

template <typename T, size_t BufSize = DefaultSmallSize>
using SmallArena = typename SmallAllocator<T, BufSize>::arena_type;

}  // namespace memory

using SmallCharVector = memory::SmallVector<char>;
using SmallCharArena = memory::SmallArena<char>;
using SmallCharAllocator = memory::SmallAllocator<char>;

}  // namespace ap
