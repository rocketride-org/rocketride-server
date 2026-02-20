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

inline void __transform(StatInfo& info, const ::WIN32_FIND_DATAW& platInfo,
                        const Path& path) noexcept {
    info.plat = platInfo;

    // Fill in the generic stuff
    info.changeTime =
        NullOpt;  // Windows doesn't have a direct mapping to changeTime
    info.createTime = _tr<time::SystemStamp>(info.plat.ftCreationTime);
    info.accessTime = _tr<time::SystemStamp>(info.plat.ftLastAccessTime);
    info.modifyTime = _tr<time::SystemStamp>(info.plat.ftLastWriteTime);
    info.size = (_cast<uint64_t>(info.plat.nFileSizeHigh) << 32) +
                info.plat.nFileSizeLow;
    info.inode = 0;
    info.isRegular = true;
    info.isLink = false;
    info.isDir = info.plat.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY;
    info.isOffline =
        info.plat.dwFileAttributes &
        (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS);

    // Calculate size on disk
    if (!info.isDir) {
        if (auto sizeOnDisk =
                getSizeOnDisk(path, info.size, info.plat.dwFileAttributes);
            !sizeOnDisk.check())
            info.sizeOnDisk = *sizeOnDisk;
    }

    // Determine whether the directory is a symlink
    if (info.isDir &&
        (info.plat.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
        info.isLink = info.plat.dwReserved0 == IO_REPARSE_TAG_APPEXECLINK ||
                      info.plat.dwReserved0 == IO_REPARSE_TAG_WCI ||
                      info.plat.dwReserved0 == IO_REPARSE_TAG_MOUNT_POINT ||
                      info.plat.dwReserved0 == IO_REPARSE_TAG_SYMLINK;
    }
}

inline void __transform(StatInfo& info,
                        const ::BY_HANDLE_FILE_INFORMATION& platInfo,
                        const Path& path) noexcept {
    // Bootstrap the stat info by emulating a find info
    ::WIN32_FIND_DATAW findInfo = {};
    findInfo.ftCreationTime = platInfo.ftCreationTime;
    findInfo.ftLastAccessTime = platInfo.ftLastAccessTime;
    findInfo.ftLastWriteTime = platInfo.ftLastWriteTime;
    findInfo.nFileSizeHigh = platInfo.nFileSizeHigh;
    findInfo.nFileSizeLow = platInfo.nFileSizeLow;
    findInfo.dwFileAttributes = platInfo.dwFileAttributes;

    __transform(info, findInfo, path);

    // Extract what is unique to the by handle info, getting the file inode
    info.inode = (_cast<uint64_t>(platInfo.nFileIndexHigh) << 32) +
                 platInfo.nFileIndexLow;
    info.volumeId = platInfo.dwVolumeSerialNumber;
}

inline void __fromJson(const json::Value& val, PlatStatInfo& info) noexcept {
    info.dwFileAttributes =
        _fj<decltype(info.dwFileAttributes)>(val["dwFileAttributes"]);
    info.ftCreationTime.dwLowDateTime =
        _fj<decltype(info.ftCreationTime.dwLowDateTime)>(
            val["ftCreationTime"]["dwLowDateTime"]);
    info.ftCreationTime.dwHighDateTime =
        _fj<decltype(info.ftCreationTime.dwHighDateTime)>(
            val["ftCreationTime"]["dwHighDateTime"]);
    info.ftLastAccessTime.dwLowDateTime =
        _fj<decltype(info.ftLastAccessTime.dwLowDateTime)>(
            val["ftLastAccessTime"]["dwLowDateTime"]);
    info.ftLastAccessTime.dwHighDateTime =
        _fj<decltype(info.ftLastAccessTime.dwHighDateTime)>(
            val["ftLastAccessTime"]["dwHighDateTime"]);
    info.ftLastWriteTime.dwLowDateTime =
        _fj<decltype(info.ftLastWriteTime.dwLowDateTime)>(
            val["ftLastWriteTime"]["dwLowDateTime"]);
    info.ftLastWriteTime.dwHighDateTime =
        _fj<decltype(info.ftLastWriteTime.dwHighDateTime)>(
            val["ftLastWriteTime"]["dwHighDateTime"]);
    info.nFileSizeHigh =
        _fj<decltype(info.nFileSizeHigh)>(val["nFileSizeHigh"]);
    info.nFileSizeLow = _fj<decltype(info.nFileSizeLow)>(val["nFileSizeLow"]);
    info.dwReserved0 = _fj<decltype(info.dwReserved0)>(val["dwReserved0"]);
    info.dwReserved1 = _fj<decltype(info.dwReserved1)>(val["dwReserved1"]);

    auto cFileName = _fj<Utf16>(val["cFileName"]);
    auto cAlternateFileName = _fj<Utf16>(val["cAlternateFileName"]);

    std::memcpy(info.cFileName, cFileName.data(),
                std::min((sizeof(info.cFileName) / sizeof(WCHAR) - 1),
                         cFileName.size()));
    std::memcpy(info.cAlternateFileName, cAlternateFileName.data(),
                std::min((sizeof(info.cAlternateFileName) / sizeof(WCHAR) - 1),
                         cAlternateFileName.size()));
}

inline void __toJson(const PlatStatInfo& info, json::Value& val) noexcept {
    val["dwFileAttributes"] = _tj(info.dwFileAttributes);
    val["ftCreationTime"]["dwLowDateTime"] =
        _tj(info.ftCreationTime.dwLowDateTime);
    val["ftCreationTime"]["dwHighDateTime"] =
        _tj(info.ftCreationTime.dwHighDateTime);
    val["ftLastAccessTime"]["dwLowDateTime"] =
        _tj(info.ftLastAccessTime.dwLowDateTime);
    val["ftLastAccessTime"]["dwHighDateTime"] =
        _tj(info.ftLastAccessTime.dwHighDateTime);
    val["ftLastWriteTime"]["dwLowDateTime"] =
        _tj(info.ftLastWriteTime.dwLowDateTime);
    val["ftLastWriteTime"]["dwHighDateTime"] =
        _tj(info.ftLastWriteTime.dwHighDateTime);
    val["nFileSizeHigh"] = _tj(info.nFileSizeHigh);
    val["nFileSizeLow"] = _tj(info.nFileSizeLow);
    val["dwReserved0"] = _tj(info.dwReserved0);
    val["dwReserved1"] = _tj(info.dwReserved1);
    val["cFileName"] = _tj(_ts(info.cFileName));
    val["cAlternateFileName"] = _tj(_ts(info.cAlternateFileName));
}

}  // namespace ap::file
