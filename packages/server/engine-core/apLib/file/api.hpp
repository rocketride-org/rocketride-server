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

namespace ap::file {

namespace {

// Internal version takes a specific instantiated dataview type which must
// be explicitly instantiated by an intermediary call below
template <typename DataT>
inline Error putInternal(const Path& path,
                         memory::DataView<const DataT> data) noexcept {
    FileStream stream;
    if (auto ccode = stream.open(path, Mode::WRITE)) return ccode;

    if (data.empty()) return {};

    if (auto ccode =
            stream.write({data.template cast<uint8_t>(), data.byteSize()}))
        return ccode;

    return stream.close();
}

}  // namespace

// Put the contents of a data type to a file, overwrites/creates the file as
// needed
template <typename DataT>
inline Error put(const Path& path, const DataT& data) noexcept {
    if (auto ccode = mkdir(path.parent())) return ccode;

    return putInternal(path, memory::viewCast<uint8_t>(data));
}

// Specialize for utf16 character casting
template <>
inline Error put(const Path& path, const Utf16& data) noexcept {
    if (auto ccode = mkdir(path.parent())) return ccode;

    return putInternal(path, memory::viewCast<Utf16Chr>(data));
}

// Specialize for utf16 character casting
template <>
inline Error put(const Path& path, const Utf16View& data) noexcept {
    if (auto ccode = mkdir(path.parent())) return ccode;

    return putInternal(path, memory::viewCast<Utf16Chr>(data));
}

// Convert the type to data, then put the contents of a data type to a file,
// overwrites/creates the file as needed
template <typename DataT>
inline Error putToData(const Path& path, const DataT& data) noexcept {
    auto _data = _td(data);
    if (!_data) return _data.ccode();
    return put(path, *_data);
}

// Fetch the contents of a file up to the specified length (chained to from
// below)
template <typename DataT, typename AllocT>
inline ErrorOr<memory::Data<DataT, AllocT>> fetch(
    const FileStream& stream, size_t length, const AllocT& allocator) noexcept {
    memory::Data<DataT, AllocT> data(allocator);
    data.resize(length);
    auto sizeRead = stream.read({data.template cast<uint8_t>(), length});
    if (sizeRead.check()) return sizeRead.ccode();

    // Check for truncated items
    if constexpr (sizeof(DataT) > 1) {
        if (*sizeRead % sizeof(DataT))
            return APERR(Ec::Unexpected, "Read truncated item from file",
                         stream.path(), sizeRead);
        data.resize(*sizeRead / sizeof(DataT));
    } else
        data.resize(*sizeRead);

    return data;
}

// Fetch the entire contents of a file
template <typename DataT, typename AllocT>
inline ErrorOr<memory::Data<DataT, AllocT>> fetch(
    const Path& path, const AllocT& allocator) noexcept {
    Path resolvedPath = file::realpath(path);

    FileStream stream;
    if (auto ccode = stream.open(resolvedPath, Mode::READ)) return ccode;

    auto fileLength = stream.size();
    if (fileLength.check()) return fileLength.ccode();

    // Special files (e.g. /proc) don't have sizes, so make a simple workaround
    // for users to use file::fetch on proc things
    if (*fileLength)
        return fetch<DataT, AllocT>(stream, *fileLength, allocator);
    else
        return fetch<DataT, AllocT>(stream, 1024 * sizeof(DataT), allocator);
}

// Fetch the contents of a file up to max length
template <typename DataT, typename AllocT>
inline ErrorOr<memory::Data<DataT, AllocT>> fetchEx(
    const Path& path, size_t maxLength, const AllocT& allocator) noexcept {
    FileStream stream;
    if (auto ccode = stream.open(path, Mode::READ)) return ccode;

    return fetch<DataT, AllocT>(stream, maxLength * sizeof(DataT), allocator);
}

// Fetch the contents of a file up to the specified length as text (chained to
// from below)
template <typename ChrT, typename TraitsT, typename AllocT>
inline ErrorOr<string::Str<ChrT, TraitsT, AllocT>> fetchString(
    const FileStream& stream, size_t length, const AllocT& allocator) noexcept {
    string::Str<ChrT, TraitsT, AllocT> str(allocator);
    str.resize(length);
    auto sizeRead = stream.read(
        {_reCast<uint8_t*>(_constCast<ChrT*>(str.c_str())), length});
    if (sizeRead.check()) return sizeRead.ccode();

    // Check for truncated characters
    if constexpr (sizeof(ChrT) > 1) {
        if (*sizeRead % sizeof(ChrT))
            return APERR(Ec::Unexpected, "Read truncated character from file",
                         stream.path(), sizeRead);
        str.resize(*sizeRead / sizeof(ChrT));
    } else
        str.resize(*sizeRead);

    return str;
}

// Fetch the entire contents of a file as text
template <typename ChrT, typename TraitsT, typename AllocT>
inline ErrorOr<string::Str<ChrT, TraitsT, AllocT>> fetchString(
    const Path& path, const AllocT& allocator) noexcept {
    return fetchStringEx<ChrT, TraitsT, AllocT>(path, 1_kb, allocator);
}

// Fetch the contents of a file up to max length as text
template <typename ChrT, typename TraitsT, typename AllocT>
inline ErrorOr<string::Str<ChrT, TraitsT, AllocT>> fetchStringEx(
    const Path& path, size_t defaultReadSize,
    const AllocT& allocator) noexcept {
    Opt<FileStream> stream{std::in_place_t{}};
    if (auto ccode = stream->open(path, Mode::READ)) return ccode;

    auto fileLength = stream->size();
    if (fileLength.check()) return fileLength.ccode();

    // Special files (e.g. /proc) don't have sizes, so the algorithm attempts
    // to keep reading until it finds a block size large enough to hold the
    // entire file in a single string. The default read size should be large
    // enough to accommodate most common files of the current type. If the
    // requested length doesn't appear to be large enough, the size will double
    // until the entire file can be read in a single chunk. This is required
    // as special files may change its contents between read operations.
    if (*fileLength)
        return fetchString<ChrT, TraitsT, AllocT>(*stream, *fileLength,
                                                  allocator);

    _const size_t bounded = 1_gb;
    _forever() {
        auto result = fetchString<ChrT, TraitsT, AllocT>(
            *stream, defaultReadSize * sizeof(ChrT), allocator);
        if (result.check()) return result.ccode();

        if ((*result).length() < defaultReadSize) return result;

        stream.emplace();

        if (auto ccode = stream->open(path, Mode::READ)) return ccode;

        if (defaultReadSize >= bounded) return {};

        defaultReadSize *= 2;
    }
    return {};
}

// Fetch file contents and convert it to a type using the fromData suite
template <typename DataT>
inline ErrorOr<DataT> fetchFromData(const Path& path) noexcept {
    memory::SmallArena<uint8_t> arena;
    auto res = fetch<uint8_t, memory::SmallAllocator<uint8_t>>(path, arena);
    if (res) return _fd<DataT>(*res);
    return res.ccode();
}

// Fetch and resize to the callers string type
template <typename ChrT, typename TraitsT, typename AllocT>
inline ErrorOr<size_t> fetch(
    const Path& path, string::Str<ChrT, TraitsT, AllocT>& data) noexcept {
    FileStream stream;
    if (auto ccode = stream.open(path, Mode::READ)) return ccode;
    return stream.read(data);
}

// Copies a file from a source path (complete) to a target dir
inline Error copy(const Path& src, const Path& dst) noexcept {
    ErrorCode ec;
    if (isFile(src)) {
        if (auto ccode = mkdir(dst.parent())) return ccode;
    }
    std::filesystem::copy(src, dst, ec);
    if (ec) return APERR(ec, "copy", src, dst);
    return {};
}

// Renames a file
inline Error rename(const Path& src, const Path& dst) noexcept {
    ErrorCode ec;
    if (isFile(src)) {
        if (auto ccode = mkdir(dst.parent())) return ccode;
    }
    std::filesystem::rename(src, dst, ec);
    if (ec) return APERR(ec, "rename", src, dst);
    return {};
}

// Is file a file
inline bool isFile(const Path& path) noexcept {
    auto info = stat(path);
    if (!info) return false;
    return !info->isDir;
}

// Is file a dir
inline bool isDir(const Path& path) noexcept {
    auto info = stat(path);
    if (!info) return false;
    return info->isDir;
}

// Create one or more directories
inline Error mkdir(const Path& path) noexcept {
    // Does the directory already exist?
    if (isDir(path)) return {};

    // Does the path collide with an existing file?
    if (isFile(path))
        return APERR(Ec::InvalidParam,
                     "Attempted to create directory, but path exists as a file",
                     path);

#ifdef ROCKETRIDE_PLAT_UNX
    if (path.isUnc()) {
        // libsmbclient mkdir requires parent directory to exist.
        // Call mkdir for each parent directory that not exists
        // to create the directories recursively.
        std::stack<Path> dirs;
        Error ccode;
        for (auto dir = path; dir.valid() && !isDir(dir); dir = dir.parent())
            dirs.push(dir);
        while (!dirs.empty()) {
            const auto& dir = dirs.top();
            ccode = smb::client().createDirectory(dir);
            // check for EEXIST - another thread may create the same folder
            // meanwhile
            if (ccode && (ccode != EEXIST)) return ccode;
            dirs.pop();
        }
        return {};
    }
#endif  // ROCKETRIDE_PLAT_UNX
    ErrorCode ec;
    std::filesystem::create_directories(path, ec);
    if (ec) return APERR(ec, "mkdir", path);
    return {};
}

// Get the current working directory of the application
inline Path cwd() noexcept { return std::filesystem::current_path(); }

// Get the length of a file
inline ErrorOr<uint64_t> length(const Path& path) noexcept {
    auto info = stat(path);
    if (!info) return info.ccode();
    return info->size;
}

// Count number of matching files
inline ErrorOr<size_t> count(const Path& path) noexcept {
    // If the caller didn't specify a wildcard (*) in the path, add one for them
    file::Path filter{path};
    if (!filter.fileName().contains("*")) filter = filter / "*";

    file::FileScanner scanner(filter);
    if (auto ccode = scanner.open()) return ccode;

    size_t count = {};
    while (auto entry = scanner.next()) {
        ++count;
    }
    return count;
}

}  // namespace ap::file
