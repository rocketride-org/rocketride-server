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
#include <chrono>

#ifndef ROCKETRIDE_PLAT_MAC
#include <sys/sysmacros.h>
#endif
namespace ap::file {

inline void __transform(StatInfo &info, const PlatStatInfo &platInfo,
                        const Path &) noexcept {
    info.plat = platInfo;

    info.createTime = {};
#ifdef ROCKETRIDE_PLAT_MAC
    auto timespec_to_system_time_point = [](const timespec &ts) {
        using namespace std::chrono;

        auto d = seconds{ts.tv_sec} + nanoseconds{ts.tv_nsec};
        system_clock::time_point tp{duration_cast<system_clock::duration>(d)};

        return tp;
    };
    info.createTime = timespec_to_system_time_point(platInfo.st_birthtimespec);
    info.changeTime = timespec_to_system_time_point(platInfo.st_ctimespec);
    info.accessTime = timespec_to_system_time_point(platInfo.st_atimespec);
    info.modifyTime = timespec_to_system_time_point(platInfo.st_mtimespec);
#else
    info.changeTime = time::fromTimeT<decltype(info.changeTime)::value_type>(
        platInfo.st_ctime);
    info.accessTime =
        time::fromTimeT<decltype(info.accessTime)>(platInfo.st_atime);
    info.modifyTime =
        time::fromTimeT<decltype(info.modifyTime)>(platInfo.st_mtime);
#endif
    info.size = platInfo.st_size;

    // st_blocks is the number of 512-byte blocks allocated for the file
    // Note that sizeOnDisk will be less than size for sparse files
    info.sizeOnDisk = platInfo.st_blocks * 512;
    info.inode = platInfo.st_ino;
    info.isRegular = S_ISREG(platInfo.st_mode);
    info.isLink = S_ISLNK(platInfo.st_mode);
    info.isDir = S_ISDIR(platInfo.st_mode);
    info.volumeId = platInfo.st_dev;
}

inline void __fromJson(const json::Value &val, PlatStatInfo &info) noexcept {
    info.st_dev = _fj<decltype(info.st_dev)>(val["st_dev"]);
    info.st_ino = _fj<decltype(info.st_ino)>(val["st_ino"]);
    info.st_mode = _fj<decltype(info.st_mode)>(val["st_mode"]);
    info.st_nlink = _fj<decltype(info.st_nlink)>(val["st_nlink"]);
    info.st_uid = _fj<decltype(info.st_uid)>(val["st_uid"]);
    info.st_gid = _fj<decltype(info.st_gid)>(val["st_gid"]);
    info.st_rdev = _fj<decltype(info.st_rdev)>(val["st_rdev"]);
    info.st_size = _fj<decltype(info.st_size)>(val["st_size"]);
#if !defined(ROCKETRIDE_PLAT_MAC)
    info.st_atim = _fj<decltype(info.st_atim)>(val["st_atim"]);
    info.st_mtim = _fj<decltype(info.st_mtim)>(val["st_mtim"]);
    info.st_ctim = _fj<decltype(info.st_ctim)>(val["st_ctim"]);
#endif
    info.st_blksize = _fj<decltype(info.st_blksize)>(val["st_blksize"]);
    info.st_blocks = _fj<decltype(info.st_blocks)>(val["st_blocks"]);
}

inline void __toJson(const PlatStatInfo &info, json::Value &val) noexcept {
    val["st_dev"] = _tj(info.st_dev);
    val["st_ino"] = _tj(info.st_ino);
    val["st_mode"] = _tj(info.st_mode);
    val["st_nlink"] = _tj(info.st_nlink);
    val["st_uid"] = _tj(info.st_uid);
    val["st_gid"] = _tj(info.st_gid);
    val["st_rdev"] = _tj(info.st_rdev);
    val["st_size"] = _tj(info.st_size);
#if !defined(ROCKETRIDE_PLAT_MAC)
    val["st_atim"] = _tj(info.st_atim);
    val["st_mtim"] = _tj(info.st_mtim);
    val["st_ctim"] = _tj(info.st_ctim);
#endif
    val["st_blksize"] = _tj(info.st_blksize);
    val["st_blocks"] = _tj(info.st_blocks);
}

// Mac doesnt have statx
#ifndef ROCKETRIDE_PLAT_MAC

inline void __transform(StatInfo &info, const PlatStatInfoEx &platInfoEx,
                        const Path &path) noexcept {
    auto platInfo = _tr<PlatStatInfo>(platInfoEx);
    info = _tr<StatInfo>(platInfo, path);
    info.createTime =
        time::fromTimeT<decltype(info.createTime)>(platInfoEx.stx_btime.tv_sec);
}

inline void __fromJson(const json::Value &val,
                       struct ::statx_timestamp &stamp) {
    stamp.tv_sec = _fj<decltype(stamp.tv_sec)>(val["tv_sec"]);
    stamp.tv_nsec = _fj<decltype(stamp.tv_nsec)>(val["tv_nsec"]);
}

inline void __transform(const PlatStatInfoEx &platInfoEx,
                        PlatStatInfo &platInfo) noexcept {
    platInfo.st_dev =
        makedev(platInfoEx.stx_dev_major, platInfoEx.stx_dev_minor);
    platInfo.st_ino = platInfoEx.stx_ino;
    platInfo.st_mode = platInfoEx.stx_mode;
    platInfo.st_nlink = platInfoEx.stx_nlink;
    platInfo.st_uid = platInfoEx.stx_uid;
    platInfo.st_gid = platInfoEx.stx_gid;
    platInfo.st_rdev =
        makedev(platInfoEx.stx_rdev_major, platInfoEx.stx_rdev_minor);
    platInfo.st_size = platInfoEx.stx_size;

    platInfo.st_ctime = platInfoEx.stx_ctime.tv_sec;
    platInfo.st_atime = platInfoEx.stx_atime.tv_sec;
    platInfo.st_mtime = platInfoEx.stx_mtime.tv_sec;

#if !defined(ROCKETRIDE_PLAT_MAC)
    platInfo.st_atim.tv_sec = platInfoEx.stx_atime.tv_sec;
    platInfo.st_atim.tv_nsec = platInfoEx.stx_atime.tv_nsec;
    platInfo.st_mtim.tv_sec = platInfoEx.stx_mtime.tv_sec;
    platInfo.st_mtim.tv_nsec = platInfoEx.stx_mtime.tv_nsec;
    platInfo.st_ctim.tv_sec = platInfoEx.stx_ctime.tv_sec;
    platInfo.st_ctim.tv_nsec = platInfoEx.stx_ctime.tv_nsec;
#endif

    platInfo.st_blksize = platInfoEx.stx_blksize;
    platInfo.st_blocks = platInfoEx.stx_blocks;
}

inline void __fromJson(const json::Value &val, PlatStatInfoEx &info) noexcept {
    info.stx_dev_major =
        _fj<decltype(info.stx_dev_major)>(val["stx_dev_major"]);
    info.stx_dev_minor =
        _fj<decltype(info.stx_dev_minor)>(val["stx_dev_minor"]);
    info.stx_ino = _fj<decltype(info.stx_ino)>(val["stx_ino"]);
    info.stx_mode = _fj<decltype(info.stx_mode)>(val["stx_mode"]);
    info.stx_nlink = _fj<decltype(info.stx_nlink)>(val["stx_nlink"]);
    info.stx_uid = _fj<decltype(info.stx_uid)>(val["stx_uid"]);
    info.stx_gid = _fj<decltype(info.stx_gid)>(val["stx_gid"]);
    info.stx_rdev_major =
        _fj<decltype(info.stx_rdev_major)>(val["stx_rdev_major"]);
    info.stx_rdev_minor =
        _fj<decltype(info.stx_rdev_minor)>(val["stx_rdev_minor"]);
    info.stx_size = _fj<decltype(info.stx_size)>(val["stx_size"]);
#if !defined(ROCKETRIDE_PLAT_MAC)
    info.stx_atime = _fj<decltype(info.stx_atime)>(val["stx_atime"]);
    info.stx_mtime = _fj<decltype(info.stx_mtime)>(val["stx_mtime"]);
    info.stx_ctime = _fj<decltype(info.stx_ctime)>(val["stx_ctime"]);
    info.stx_btime = _fj<decltype(info.stx_btime)>(val["stx_btime"]);
#endif
    info.stx_blksize = _fj<decltype(info.stx_blksize)>(val["stx_blksize"]);
    info.stx_blocks = _fj<decltype(info.stx_blocks)>(val["stx_blocks"]);
}

inline void __fromJson(const struct ::statx_timestamp &stamp,
                       json::Value &val) {
    val["tv_sec"] = _tj(stamp.tv_sec);
    val["tv_nsec"] = _tj(stamp.tv_nsec);
}

inline void __toJson(const PlatStatInfoEx &info, json::Value &val) noexcept {
    val["stx_dev_major"] = _tj(info.stx_dev_major);
    val["stx_dev_minor"] = _tj(info.stx_dev_minor);
    val["stx_ino"] = _tj(info.stx_ino);
    val["stx_mode"] = _tj(info.stx_mode);
    val["stx_nlink"] = _tj(info.stx_nlink);
    val["stx_uid"] = _tj(info.stx_uid);
    val["stx_gid"] = _tj(info.stx_gid);
    val["stx_rdev_major"] = _tj(info.stx_rdev_major);
    val["stx_rdev_minor"] = _tj(info.stx_rdev_minor);
#if !defined(ROCKETRIDE_PLAT_MAC)
    val["stx_atime"] = _tj(info.stx_atime);
    val["stx_mtime"] = _tj(info.stx_mtime);
    val["stx_ctime"] = _tj(info.stx_ctime);
    val["stx_btime"] = _tj(info.stx_btime);
#endif
    val["stx_blksize"] = _tj(info.stx_blksize);
    val["stx_blocks"] = _tj(info.stx_blocks);
}
#endif
}  // namespace ap::file
