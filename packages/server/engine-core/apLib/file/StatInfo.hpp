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

/**
 * A StatInfo object is what we create when a files stat is requested.
 * It holds the metadata for the file such as timestamps and inodes.
 *
 * Timestamp mappings
 * Unx:	   statx		 stat             meaning
 * modifyTime: statx_mtime | st_mtime    |  time of last modification
 * createTime: statx_btime | No Mapping  |  time of file creation
 * accessTime: statx_atime | st_atime    |  time of last access to the file
 * changeTime: statx_ctime | st_ctime    |  time of last status change
 *
 * Windows:	   WIN32_FIND_DATAW
 * modifyTime: ftLastWriteTime           |  time of last modification
 * createTime: ftCreationTime            |  time of file creation
 * accessTime: ftLastAccessTime          |  time of last access to the file
 * changeTime: No Mapping                |  time of last status change
 */
struct StatInfo final {
    // Timestamps of the file
    time::SystemStamp modifyTime, createTime, accessTime;

    // Windows doesn't provide a direct mapping to unix st_ctime
    // so we only fill it when it exists
    Opt<time::SystemStamp> changeTime;

    // Size of the file
    uint64_t size = {};

    // Size of file on disk (i.e. sectors used)
    uint64_t sizeOnDisk = {};

    // Inode of the file
    uint64_t inode = {};

    // Volume id file resides on (devid on linux, volume serial number on
    // windows)
    uint64_t volumeId = {};

    // Platform specific info
    PlatStatInfo plat;

    // Various flags for attributes
    bool isRegular = {};
    bool isDir = {};
    bool isLink = {};
    bool isOffline = {};

    bool operator==(const StatInfo& info) const noexcept {
        if (changeTime != info.changeTime) {
            LOG(FileStat, "changeTime {} != {}", changeTime, info.changeTime);
            return false;
        }

        if (modifyTime != info.modifyTime) {
            LOG(FileStat, "modifyTime {} != {}", modifyTime, info.modifyTime);
            return false;
        }

        if (accessTime != info.accessTime) {
            LOG(FileStat, "accessTime {} != {}", accessTime, info.accessTime);
            return false;
        }

        if (createTime != info.createTime) {
            LOG(FileStat, "createTime {} != {}", createTime, info.createTime);
            return false;
        }

        if (size != info.size) {
            LOG(FileStat, "size {} != {}", size, info.size);
            return false;
        }
        if (sizeOnDisk != info.sizeOnDisk) {
            LOG(FileStat, "sizeOnDisk {} != {}", sizeOnDisk, info.sizeOnDisk);
            return false;
        }

        if (!(!inode || !info.inode || inode == info.inode)) {
            LOG(FileStat, "inode {} != {}", inode, info.inode);
            return false;
        }

        if (isRegular != info.isRegular) {
            LOG(FileStat, "isRegular {} != {}", isRegular, info.isRegular);
            return false;
        }

        if (isDir != info.isDir) {
            LOG(FileStat, "isDir {} != {}", isDir, info.isDir);
            return false;
        }

        if (isLink != info.isLink) {
            LOG(FileStat, "isLink {} != {}", isLink, info.isLink);
            return false;
        }

        if (isOffline != info.isOffline) {
            LOG(FileStat, "isOffline {} != {}", isOffline, info.isOffline);
            return false;
        }

        return true;
    }

    bool operator!=(const StatInfo& info) const noexcept {
        return operator==(info) == false;
    }

    auto __jsonSchema() const noexcept {
        return json::makeSchema(
            modifyTime, "modifyTime", createTime, "createTime", changeTime,
            "changeTime", accessTime, "accessTime", size, "size", sizeOnDisk,
            "sizeOnDisk", inode, "inode", volumeId, "volumeId", isRegular,
            "isRegular", isDir, "isDir", isLink, "isLink", isOffline,
            "isOffline");
    }
};

}  // namespace ap::file
