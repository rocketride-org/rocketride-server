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

//-----------------------------------------------------------------------------
//
//	Defines the segmented read/write functions. These are for getting
//  and putting data into the IO buffer on segmented files in the rocketride
//  format.
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::filesys::base {
ErrorOr<std::wstring> getFinalPath(const Path &objectPath) noexcept;

//---------------------------------------------------------------------
/// @details
///		Processes an entry
///	@param[in]	parentPath
///		The parent of the object
/// @param[in]	findInfo
///		The find information we got back
///	@param[out]	objectPath
///		Receives the object path
///	@param[out]	object
///		Receives the signalled object
///	@param[in]	addObject
///		The function to add the object
///	@returns
///		Error
//---------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysEndpoint<LvlT>::processEntry(
    Path &parentPath, WIN32_FIND_DATAW &findInfo, Path &objectPath,
    Entry &object, const ScanAddObject &addObject) noexcept {
    // Set the standard stuff
    object.size(((Qword)findInfo.nFileSizeHigh) << 32 | findInfo.nFileSizeLow);
    object.attrib(findInfo.dwFileAttributes);
    object.createTime(time::toTimeT(findInfo.ftCreationTime));
    object.modifyTime(time::toTimeT(findInfo.ftLastWriteTime));
    object.accessTime(time::toTimeT(findInfo.ftLastAccessTime));
    object.name(findInfo.cFileName);
    object.storeSize(0);

    // If it is the current indicator, skip it
    if (object.name() == "." || object.name() == "..") return {};

    // Get the full path
    objectPath = parentPath / object.name();

    // Tell the scanner wether we need to recurse "into" this
    if (findInfo.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
        // By default, it is a container
        object.isContainer(true);

        // Directories do not have a storage size
        object.storeSize(0);

        // If this is a junction or symbolic link
        bool isSymlink =
            (findInfo.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
            (findInfo.dwReserved0 == IO_REPARSE_TAG_APPEXECLINK ||
             findInfo.dwReserved0 == IO_REPARSE_TAG_WCI ||
             findInfo.dwReserved0 == IO_REPARSE_TAG_MOUNT_POINT ||
             findInfo.dwReserved0 == IO_REPARSE_TAG_SYMLINK);

        // If we are not to process symlinks
        if (m_excludeSymlinks) {
            // Do not traverse a junction or symbolic link.
            if (isSymlink) {
                LOGT("Skipping symlink", objectPath);
                return {};
            }
        } else {
            auto finalPath = getFinalPath(objectPath);

            if (finalPath.hasCcode()) {
                // Skip it
                MONERR(warning, finalPath.ccode(), "Skipping",
                       isSymlink ? "symlink" : "directory", "due to error",
                       objectPath);
                return {};
            }

            uint32_t pathHash = crypto::crc32(
                {_reCast<const uint8_t *>(finalPath->data()),
                 finalPath->size() * sizeof(finalPath->data()[0])});

            // If this directory or the target directory of the this link is
            // already scanned
            bool isScanned = false;
            {
                auto guard = m_scannedEntriesLock.acquire();
                isScanned = !m_scannedEntries.insert(pathHash).second;
            }
            if (isScanned) {
                if (isSymlink)
                    LOGT(
                        "Scan symlink as file due to target directory already "
                        "scanned",
                        objectPath, "<<<===>>>", finalPath);
                else
                    LOGT(
                        "Scan directory as file due to already scanned by "
                        "symlink",
                        objectPath);

                // We treat it as an empty object
                object.isContainer(false);

                // Add some context just for the case
                if (!object.objectTags())
                    object.objectTags(json::Value(json::objectValue));
                object.objectTags()["symlink"] = isSymlink;
                object.objectTags()["target"] = Text(*finalPath);
            }
        }
    } else {
        // This is not a container
        object.isContainer(false);

        // If it is offline, skip it
        if (object.attrib() & FILE_ATTRIBUTE_OFFLINE) {
            // Skip it
            MONERR(warning, Ec::Excluded, "Skipping file which is OFFLINE",
                   objectPath);
            return {};
        }

        // Default to the size
        object.storeSize(object.size());

        // Get the size on disk
        if (auto sizeOnDisk = getSizeOnDisk(objectPath.plat(), object.size(),
                                            object.attrib())) {
            if (sizeOnDisk) object.storeSize(*sizeOnDisk);
        }
    }

    // Add the object
    return addObject(object);
};

//---------------------------------------------------------------------
/// @details
///		On an empty path, all the root drives will be processed.
///		Interestingly enough, the orginal scan code was checking
///		every file to determine if is was on a removable drive or
///		not and then determing if it was specifically include. Now,
///		We just need to check the drive here before we load the roots
///		an not add removable drives
//---------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysEndpoint<LvlT>::loadRoots(
    Path &objectPath, Entry &object, const ScanAddObject &addObject) noexcept {
    // Get the root drives
    auto roots = file::loadRoots();
    if (!roots) return roots.ccode();

    // Clear the object
    object.reset();

    // For each root
    for (auto &root : *roots) {
        // Fill in all that is needed
        object.isContainer(true);
        object.name((Text)root);

        // Determine if this is a removable drive
        if (m_excludeExternalDrives && file::isOnRemovableDrive(root)) continue;

        // And declare it
        if (auto ccode = addObject(object)) return ccode;
    }

    return {};
}

//---------------------------------------------------------------------
/// @details
///		Given a path to scan, this function will enumerate the children and
///		call the add object function. We handle containers (directories)
///		the same as objects, just returning them and let the scanner
///		figure out what to do. It is up to this function to ensure that the
///		object should actually be included with the selection lists
///	@param[in]	path
///		Path to scan
///	@param[in] 	addObject
///		Ptr to the function to call for each object we found
///	@returns
///		Error
//---------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysEndpoint<LvlT>::scanObjects(
    Path &path, const ScanAddObject &addObject) noexcept {
    Entry object;
    Path objectPath;
    uint64_t count = 0;
    auto start = time::now();
    WIN32_FIND_DATAW info;
    HANDLE hFind = {};
    Error ccode;

    // If empty path, search everything
    if (!path) return loadRoots(path, object, addObject);

    // Create a url
    Url url;
    if (ccode = Url::toUrl(Type, path, url)) return ccode;

    // Get the os path
    Text osPath;
    if (ccode = Url::osPath(url, osPath)) return ccode;

    // Prepare the search path
    if (!osPath.endsWith("\\")) osPath += "\\";
    osPath += "*";

    // Find the first file
    hFind =
        FindFirstFileExW(osPath, FindExInfoBasic, &info, FindExSearchNameMatch,
                         nullptr, FIND_FIRST_EX_LARGE_FETCH);

    // Find all the files/dir
    while (hFind != INVALID_HANDLE_VALUE) {
        // One more entry processed
        count++;

        // Clear the object
        object.reset();

        // Process this entry
        if (ccode = processEntry(path, info, objectPath, object, addObject)) {
            auto fullPath = path / info.cFileName;
            MONERR(error, ccode, "Scanning on", fullPath.gen(), "failed");
            object.completionCode(ccode);
        }

        // Get the next one
        if (!FindNextFileW(hFind, &info)) break;
    }

    // Close it
    if (hFind != INVALID_HANDLE_VALUE) FindClose(hFind);

    LOGT("Scan elapsed {}, completed {} objects", time::now() - start, path,
         count);

    // And return any error
    return ccode;
}

//---------------------------------------------------------------------
/// @details
///		Retrieves the final path for the specified file.
//---------------------------------------------------------------------
ErrorOr<std::wstring> getFinalPath(const Path &objectPath) noexcept {
    HANDLE hFile =
        CreateFileW(objectPath.plat(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                    OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);

    if (hFile == INVALID_HANDLE_VALUE)
        return APERR(::GetLastError(), "Failed to open object",
                     objectPath.plat());

    util::Guard guard([hFile] { CloseHandle(hFile); });

    std::wstring finalPath;
    _forever() {
        finalPath.resize(finalPath.size() + MAX_PATH);

        DWORD dwRet = GetFinalPathNameByHandleW(hFile, finalPath.data(),
                                                _cast<DWORD>(finalPath.size()),
                                                FILE_NAME_NORMALIZED);

        if (dwRet == 0)
            return APERR(::GetLastError(), "Failed to get final path",
                         objectPath);

        if (dwRet > finalPath.size()) continue;

        finalPath.resize(dwRet);
        break;
    }
    return finalPath;
}
}  // namespace engine::store::filter::filesys::base
