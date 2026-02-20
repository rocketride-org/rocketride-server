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

template <typename DataT>
Error put(const Path& src, const DataT& data) noexcept;

template <typename DataT = uint8_t, typename AllocT = std::allocator<DataT>>
ErrorOr<memory::Data<DataT, AllocT>> fetch(
    const Path& src, const AllocT& allocator = {}) noexcept;

template <typename DataT = uint8_t, typename AllocT = std::allocator<DataT>>
ErrorOr<memory::Data<DataT, AllocT>> fetchEx(
    const Path& src, size_t maxLength, const AllocT& allocator = {}) noexcept;

template <typename ChrT = char, typename TraitsT = string::Case<ChrT>,
          typename AllocT = std::allocator<ChrT>>
ErrorOr<string::Str<ChrT, TraitsT, AllocT>> fetchString(
    const Path& src, const AllocT& allocator = {}) noexcept;

template <typename ChrT = char, typename TraitsT = string::Case<ChrT>,
          typename AllocT = std::allocator<ChrT>>
ErrorOr<string::Str<ChrT, TraitsT, AllocT>> fetchStringEx(
    const Path& src, size_t maxLength, const AllocT& allocator = {}) noexcept;

template <typename DataT>
ErrorOr<DataT> fetchFromData(const Path& src) noexcept;

template <typename ChrT, typename TraitT, typename AllocT>
ErrorOr<size_t> fetch(const Path& src,
                      string::Str<ChrT, TraitT, AllocT>& data) noexcept;

Error copy(const Path& src, const Path& dst) noexcept;
Error remove(const Path& src) noexcept;
Error rename(const Path& src, const Path& dst) noexcept;
bool exists(const Path& src) noexcept;
bool isDir(const Path& path) noexcept;
bool isFile(const Path& path) noexcept;
Error mkdir(const Path& path) noexcept;
Path cwd() noexcept;
ErrorOr<StatInfo> stat(const Path& path, bool full = false) noexcept;
ErrorOr<uint64_t> length(const Path& path) noexcept;
ErrorOr<std::vector<Path>> loadRoots() noexcept;
ErrorOr<size_t> count(const Path& path) noexcept;

template <typename Api>
ErrorOr<typename Api::Type> hash(const file::Path& path,
                                 Opt<Ref<StatInfo>> info = {}) noexcept;

#if ROCKETRIDE_PLAT_WIN
uint32_t getDriveMap() noexcept;
#endif

}  // namespace ap::file
