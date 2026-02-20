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
// Deletes a file
inline Error remove(const Path& path) noexcept {
    const auto osPath = path.plat();

    if (file::isFile(path)) {
        if (!::DeleteFileW(osPath))
            return APERR(GetLastError(), "remove file", path);
    } else {
        if (!::RemoveDirectoryW(osPath))
            return APERR(GetLastError(), "remove dir", path);
    }
    return {};
}

// Load stat info for a file
inline ErrorOr<StatInfo> statByHandle(const Path& path) noexcept {
    // Use our lowest level api to access a file, same one used
    // in the stream wrapper object
    stream::File file;

    // Open it, if it doesn't exist here we don't have to try twice
    if (auto ccode = file.open(path.plat(), Mode::STAT)) return ccode;

    // It'll return a platform specific stat info, in our case
    // BY_HANDLE_INFO..., which is what our StatInfo inherits from
    // so we just gotta fill in the cross platform info
    auto platStat = file.stat();

    // If we couldn't stat, could be we forgot the trailing sep, try once more
    if (!platStat) {
        if (auto ccode = file.open(path.platTrailingSep(), Mode::STAT))
            return ccode;
        if (!(platStat = file.stat())) return platStat.ccode();
    }

    // Construct its base class directly
    return _tr<StatInfo>(*platStat, path);
}

// Load stat info for a file
inline ErrorOr<StatInfo> stat(const Path& path, bool full) noexcept {
    // If full stats are requested do a by handle stat
    if (full) return statByHandle(path);

    // Use our lowest level api to access a file, same one used
    // in the stream wrapper object
    scan::FileScanner<WCHAR> scanner(path);

    // If we can't scan, try opening it instead
    if (auto ccode = scanner.open()) return statByHandle(path);

    // It'll return a platform specific stat info and a name
    auto entry = scanner.next();
    if (!entry) return entry.ccode();
    auto [name, stat] = _mv(*entry);

    return _tr<StatInfo>(stat, path);
}

// Checks if a file exists
inline bool exists(const Path& path) noexcept {
    const auto osPath = path.plat();

    // Get the attributes
    DWORD dwAttrib = ::GetFileAttributes(osPath);

    // If they are invalid, does not exist
    return (dwAttrib == INVALID_FILE_ATTRIBUTES) ? false : true;
}

inline ErrorOr<std::vector<Path>> loadRoots() noexcept {
    // Selections wants us to scan the whole system so use drive letters for now
    file::DriveLetterScanner scanner;
    if (auto ccode = scanner.open()) return ccode;

    // Add it to the roots list
    std::vector<Path> roots;
    while (auto vol = scanner.next()) roots.emplace_back(*vol);

    return roots;
}

// Hash a file
template <typename Api>
inline ErrorOr<typename Api::Type> hash(const file::Path& path,
                                        Opt<Ref<StatInfo>> info) noexcept {
    // Record the current access time and restore after signing
    Opt<time::SystemStamp> atime;
    _using(auto res = file::stat(path)) {
        if (res)
            atime = res->accessTime;
        else
            LOG(JobSign,
                "Failed to stat file; file access time will not be preserved "
                "during signing",
                res.ccode(), path);
    }

    FileStream stream;
    if (auto ccode = stream.open(path, Mode::READ)) return ccode;

    if (info) {
        auto _info = stream.stat();
        if (!_info) return _info.ccode();
        info->get() = _mv(_info);
    }

    auto res =
        _call([&] { return Api::make(memory::adapter::makeInput(stream)); });
    stream.close();

    // Restore the access time
    if (atime) {
        if (auto ccode = plat::setFileAccessTime(path, _tr<FILETIME>(*atime)))
            LOG(JobSign,
                "Failed to restore file access time; file access time was not "
                "preserved during signing",
                ccode, path);
    }

    return res;
}

// Get a list of all volumes
inline ErrorOr<std::vector<Path>> volumes() noexcept {
    VolumeScanner scanner;
    if (auto ccode = scanner.open()) return ccode;
    std::vector<Path> vols;
    while (auto vol = scanner.next()) vols.emplace_back(*vol);
    return vols;
}

// Normalizes the case of a path
inline ErrorOr<Path> normalizePathCase(const Path& source) noexcept {
    // Validate path type and determine root of path
    size_t subPathStartsAt = {};
    if (source.isUnc())
        subPathStartsAt = 2;
    else if (source.type() == PathType::ABSOLUTE)
        subPathStartsAt = 1;
    else
        return Error{Ec::InvalidParam, _location, "Cannot normalize {}",
                     source};

    // To normalize cases we scan the parents for their children
    auto normalizedPath = source.subpth(0, subPathStartsAt);

    for (auto& comp : source.subpth(subPathStartsAt)) {
        // Scan and find the target
        FileScanner scan(normalizedPath / comp);
        if (auto ccode = scan.open()) return ccode;
        auto normalizedComp = scan.next();
        if (!normalizedComp) return normalizedComp.ccode();
        normalizedPath = normalizedPath / normalizedComp->first;
    }

    return normalizedPath;
}

// Gets the mount point for a path, for example c:/test.txt => c:/
inline ErrorOr<Path> getVolumePathName(const Path& source) noexcept {
    Array<WCHAR, MAX_PATH + 1> name;
    if (!::GetVolumePathNameW(source.plat(), &name.front(),
                              _cast<DWORD>(name.size())))
        return Error{::GetLastError(), _location,
                     "Failed to determine volume name for path {}", source};
    return Path{&name.front()};
}

// Get the volume path of a mount point, for example c:/ => //?/Volume{GUID}/
inline ErrorOr<Path> getVolumeNameFromPath(
    const Path& source, Opt<Ref<Path>> mountPoint = {}) noexcept {
    // First resolve the mount point from the path
    auto mountPointPath = getVolumePathName(source);
    if (!mountPointPath) return mountPointPath.ccode();

    if (mountPoint) mountPoint->get() = *mountPointPath;

    // Now get the volume name from the mount point path
    Array<WCHAR, MAX_PATH + 1> name;
    if (!::GetVolumeNameForVolumeMountPointW(
            mountPointPath->plat(), &name.front(), _cast<DWORD>(name.size())))
        return Error{::GetLastError(), _location,
                     "Failed to determine volume name for path {}", source};

    return Path{&name.front()};
}

inline uint32_t getDriveMap() noexcept {
    Text driveName;
    DWORD driveMap = 0;
    DWORD logicalDrives;
    WCHAR volumeName[MAX_PATH];
    WCHAR targetPath[MAX_PATH];
    UINT driveType;
    DWORD serialNumber;
    DWORD flags;
    int x;

    // Get the logical drive bitmask
    logicalDrives = ::GetLogicalDrives();

    // Loop through each of the drives
    for (x = 2; x < 26; x++) {
        // If the drive is not valid, skip it
        if (!(logicalDrives & (1 << x))) continue;

        // Get the name of the drive
        driveName = (TextChr)(x + 'A');
        driveName += ":\\";
        Utf16 driveNameW = driveName;

        // And get the type
        driveType = GetDriveTypeW(driveNameW);

        // If this is not a fixed disk, skip it
        if (driveType != DRIVE_FIXED) continue;

        // Get the volume info
        if (!::GetVolumeInformationW(
                driveNameW, volumeName, sizeof(volumeName) / sizeof(WCHAR),
                &serialNumber, nullptr, &flags, nullptr, 0))
            continue;

        // Get the name of the drive (without the \)
        driveName = (TextChr)(x + 'A');
        driveName += ":";
        driveNameW = driveName;

        // Get the mapping for the dos device - if we fail, skip it
        if (::QueryDosDeviceW(driveNameW, targetPath,
                              sizeof(targetPath) / sizeof(WCHAR)) < 1)
            continue;

        // See if it is a mapped drive
        if (::wcsncmp(targetPath, L"\\Device", 7)) continue;

        // And set the bit
        driveMap = driveMap | (1 << x);
    }
    return driveMap;
}

inline ErrorOr<uint64_t> getDiskClusterSize(const Path& path) noexcept {
    // Make sure we're either dealing with the drive letter of an absolute path
    // or a UNC path of the form "\\host\share"
    if (path.type() == PathType::ABSOLUTE) {
        if (path.count() > 1) return getDiskClusterSize(path.subpth(0, 1));
    } else if (path.isUnc()) {
        if (path.count() > 2) return getDiskClusterSize(path.subpth(0, 2));
    } else
        return APERR(Ec::NotSupported,
                     "Cannot calculate disk cluster size for this type of path",
                     path, path.type());

    static async::SharedLock cacheLock;
    static std::map<Path, uint64_t> cachedDiskClusterSizes;

    // Look up the disk cluster size in the local cache
    _using(auto readLock = cacheLock.readLock()) {
        if (auto it = cachedDiskClusterSizes.find(path);
            it != cachedDiskClusterSizes.end())
            return it->second;
    }

    // Not cached-- calculate the disk cluster size by calling GetDiskFreeSpace
    DWORD sectorsPerCluster;
    DWORD bytesPerSector;
    DWORD ignored;
    if (!::GetDiskFreeSpaceW(path.platTrailingSep(), &sectorsPerCluster,
                             &bytesPerSector, &ignored, &ignored))
        return APERR(::GetLastError(), "GetDiskFreeSpaceW failed", path);

    // Cache and return the result
    auto diskClusterSize = _cast<uint64_t>(sectorsPerCluster * bytesPerSector);
    auto writeLock = cacheLock.writeLock();
    auto inserted = cachedDiskClusterSizes.emplace(_mv(path), diskClusterSize);
    return diskClusterSize;
}

// Get actual size of sparse, compressed, and offline files (also works for
// ordinary files)
inline ErrorOr<uint64_t> getCompressedFileSize(const Path& path) noexcept {
    DWORD compressedSizeHigh = {};
    const DWORD compressedSizeLow =
        ::GetCompressedFileSizeW(path.plat(), &compressedSizeHigh);
    if (compressedSizeLow == INVALID_FILE_SIZE)
        return APERR(::GetLastError(), "GetCompressedFileSizeW failed", path);

    return (_cast<uint64_t>(compressedSizeHigh) << 32) + compressedSizeLow;
}

// Get on-disk size of file i.e. the actual file size aligned to the disk sector
// size
inline ErrorOr<uint64_t> getSizeOnDisk(const Path& path, uint64_t size,
                                       uint32_t attributes) {
    if (attributes & FILE_ATTRIBUTE_DIRECTORY)
        return APERR(Ec::InvalidParam, "Can't calculate on-disk directory size",
                     path);

    // Sparse, compressed, and offline files require calling
    // GetCompressedFileSizeW, but this API can be expensive. See
    // https://ztw3.com/forum/forum_entry.php?id=122046. The check for ARCHIVE
    // was removed since this really has nothing to do with whether the file is
    // a different logical vs physical size. Only call for those files with
    // attributes that require special treatment.
    if (attributes & (FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED |
                      FILE_ATTRIBUTE_OFFLINE)) {
        auto actualSize = getCompressedFileSize(path);
        if (actualSize.check()) return actualSize.ccode();

        // Update size
        size = *actualSize;
    }

    // Empty files are always 0
    if (!size) return 0ull;

    // Get the cluster size of the disk
    auto diskClusterSize = getDiskClusterSize(path);
    if (diskClusterSize.check()) return diskClusterSize.ccode();

    // And compute it
    return ((size + *diskClusterSize - 1) / *diskClusterSize) *
           (*diskClusterSize);
}

inline Path realpath(const Path& path) noexcept { return path; }

}  // namespace ap::file
