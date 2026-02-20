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

// Common stack string definitions
_const size_t StrStackSize = 4096;
_const auto StrStackAlign = alignof(std::max_align_t);

// Define the generic base
template <typename ChrT>
using StackStrAllocator =
    memory::ShortAllocator<ChrT, StrStackSize, StrStackAlign>;

template <typename ChrT>
using StackStrArena = typename StackStrAllocator<ChrT>::arena_type;

template <typename ChrT,
          template <typename ChrTT> typename TraitT = string::Case>
using StackStr = string::Str<ChrT, TraitT<ChrT>, StackStrAllocator<ChrT>>;

// Define text specializations
using StackTextAllocator = StackStrAllocator<TextChr>;
using StackTextArena = typename StackStrAllocator<TextChr>::arena_type;
using StackText = StackStr<TextChr, string::Case>;
using iStackText = StackStr<TextChr, string::NoCase>;
using StackTextVector = string::StrVector<TextChr, string::Case<TextChr>,
                                          StackStrAllocator<TextChr>>;

// Define utf16 specializations
using StackUtf16Allocator = StackStrAllocator<Utf16Chr>;
using StackUtf16Arena = typename StackStrAllocator<Utf16Chr>::arena_type;
using StackUtf16 = StackStr<Utf16Chr, string::Case>;
using iStackUtf16 = StackStr<Utf16Chr, string::NoCase>;
using StackUtf16Vector = string::StrVector<Utf16Chr, string::Case<Utf16Chr>,
                                           StackStrAllocator<Utf16Chr>>;

}  // namespace ap
