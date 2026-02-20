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

namespace ap::file {

// Define a path string, a string with the platform path trait
template <typename ChrT = Utf8Chr>
using WinPathTrait = PathTrait<ChrT, string::NoCase>;

template <typename ChrT = Utf8Chr>
using UnxPathTrait = PathTrait<ChrT, string::Case>;

template <typename ChrT = Utf8Chr, typename AllocT = std::allocator<ChrT>>
using PathStr =
    std::conditional_t<plat::IsWindows,
                       string::Str<ChrT, WinPathTrait<ChrT>, AllocT>,
                       string::Str<ChrT, UnxPathTrait<ChrT>, AllocT>>;

template <typename ChrT = Utf8Chr>
using PathStrView =
    std::conditional_t<plat::IsWindows,
                       string::StrView<ChrT, WinPathTrait<ChrT>>,
                       string::StrView<ChrT, UnxPathTrait<ChrT>>>;

}  // namespace ap::file
