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
// Deletes a file
inline Error remove(const Path& path) noexcept {
    ErrorCode ec;
    if (path.isUnc()) {
        return smb::client().remove(path);
    } else {
        std::filesystem::remove(path, ec);
        if (ec) return APERR(ec, "remove", path);
    }
    return {};
}

inline ErrorOr<StatInfo> stat(const Path& path, bool) noexcept {
    if (path.isUnc()) {
        auto platInfoOr = smb::client().stat(path);
        if (platInfoOr.hasCcode()) return platInfoOr.ccode();
        return _tr<StatInfo>(platInfoOr.value(), path);
    } else {
#ifndef ROCKETRIDE_PLAT_MAC
        PlatStatInfoEx platInfo;
        if (::statx(AT_FDCWD, path.plat(), AT_SYMLINK_NOFOLLOW, STATX_ALL,
                    &platInfo))
            return APERR(errno, "Failed to statx", path);
        return _tr<StatInfo>(platInfo, path);
#else
        PlatStatInfoEx platInfo;
        if (::stat(path.plat(), &platInfo))
            return APERR(errno, "Failed to stat", path);
        return _tr<StatInfo>(platInfo, path);
#endif
    }
}

// Checks if a file exists
inline bool exists(const Path& path) noexcept {
    return path.isUnc() ? smb::client().stat(path).hasValue()
                        : access(path.plat().c_str(), F_OK) == 0;
}

inline ErrorOr<std::vector<Path>> loadRoots() noexcept {
    return std::vector<Path>{""};
}

template <typename Api>
inline ErrorOr<typename Api::Type> hashLocalFile(
    const file::Path& path, Opt<Ref<StatInfo>> info = {}) noexcept {
    ASSERT(!path.isUnc());
    FileStream stream;
    if (auto ccode = stream.open(path, Mode::READ)) return ccode;

    if (info) {
        auto _info = stream.stat();
        if (!_info) return _info.ccode();
        info->get() = _mv(_info);
    }

    // Record the current access time and restore after signing
    Opt<timespec> atime;
    util::Guard restoreFileAccessTime([&]() noexcept {
        if (atime) {
            if (auto ccode =
                    plat::setFileAccessTime(stream.platHandle(), *atime))
                LOG(JobSign,
                    "Failed to restore file access time; file access time was "
                    "not preserved during signing",
                    ccode, path);
        }
    });

    _using(auto res = plat::getFileAccessTime(stream.platHandle())) {
        if (res)
            atime = *res;
        else
            LOG(JobSign,
                "Failed to stat file; file access time will not be preserved "
                "during signing",
                res.ccode(), path);
    }

    return _call([&] { return Api::make(memory::adapter::makeInput(stream)); });
}

template <typename Api>
inline ErrorOr<typename Api::Type> hashSmbFile(
    const file::Path& path, Opt<Ref<StatInfo>> info = {}) noexcept {
    ASSERT(path.isUnc());
    stream::Stream<stream::SmbFile> stream;
    if (auto ccode = stream.open(path, Mode::READ)) return ccode;

    if (info) {
        auto _info = stream.stat();
        if (!_info) return _info.ccode();
        info->get() = _mv(_info);
    }

    // Reading the file over SMB doesn't update its atime, so don't bother
    // trying to preserve it
    return _call([&] { return Api::make(memory::adapter::makeInput(stream)); });
}

// Hash a file
template <typename Api>
inline ErrorOr<typename Api::Type> hash(const file::Path& path,
                                        Opt<Ref<StatInfo>> info) noexcept {
    return path.isUnc() ? hashSmbFile<Api>(path, info)
                        : hashLocalFile<Api>(path, info);
}

inline Path realpath(const Path& path) noexcept {
    Array<char, PATH_MAX> resolved;
    if (::realpath(path.plat(), &resolved.front())) {
        file::Path resolvedPath = &resolved.front();
        return resolvedPath;
    }

    return path;
}

// given a FsType, if possible, determine if the file system is by default
// removable
Opt<bool> isRemovable(FsType type) noexcept;
Opt<bool> isRemovable(const std::vector<FsType>& types) noexcept;
ap::file::FsType toFsType(TextView str) noexcept;
std::vector<FsType> toFsTypeArray(TextView str) noexcept;

}  // namespace ap::file
