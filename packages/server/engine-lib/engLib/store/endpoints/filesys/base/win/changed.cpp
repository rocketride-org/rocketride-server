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
//	The class definition for Windows file system node
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::filesys::base {
//-------------------------------------------------------------------------
/// @details
///		Checks if the object has changed. It does this by examining the
///		dates/times and anything else to determine if the object has
///		changed. If it has, this method should call the entry.markChanged<>
///		function. Also, if it has changed, be sure to update all the
///		changed fields in the entry
///	@param[inout] object
///		The entry to check/update
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::checkChanged(Entry &object) noexcept {
    WIN32_FIND_DATAW findInfo;
    Error ccode;

    // Get the os path
    Text osPath;
    if (ccode = Url::osPath(object.url(), osPath)) return ccode;

    // Use FindFirstFile instead of GetFileAttributes/GetFileAttributesEx
    // to get information about reparse points in addition to regular file
    // data
    HANDLE hFile = FindFirstFileW(osPath, &findInfo);

    // If we got an error, return it - its probable because the file is missing
    if (hFile == INVALID_HANDLE_VALUE) {
        // Generate the message
        return APERR(GetLastError(), _location,
                     "Unable to determine if the file has changed");
    }

    // Close the find and done
    FindClose(hFile);

    // Defaut to no change
    object.changed(false);

    // Check the create time
    if (object.createTime.get() !=
        _tr<time::SystemStamp>(findInfo.ftCreationTime)) {
        object.markChanged(LogLevel, "Creation time different");
        object.createTime(_tr<time::SystemStamp>(findInfo.ftCreationTime));
    }

    // Check the modify time
    if (object.modifyTime.get() !=
        _tr<time::SystemStamp>(findInfo.ftLastWriteTime)) {
        object.markChanged(LogLevel, "Modification time different");
        object.modifyTime(_tr<time::SystemStamp>(findInfo.ftLastWriteTime));
    }

    // Check the access time (but don't consider it changed)
    if (object.accessTime.get() !=
        _tr<time::SystemStamp>(findInfo.ftLastAccessTime)) {
        object.accessTime(_tr<time::SystemStamp>(findInfo.ftLastAccessTime));
    }

    // Check the attributes - might want to limit this to a subset
    if (object.attrib() != findInfo.dwFileAttributes) {
        object.markChanged(LogLevel, "Attributes have changed");
        object.attrib(findInfo.dwFileAttributes);
    }

    // Get the size
    uint64_t size =
        ((uint64_t)findInfo.nFileSizeHigh) << 32 | findInfo.nFileSizeLow;
    if (object.size() != size) {
        object.markChanged(LogLevel, "Size is different");
        object.size(size);
    }

    // Get the size on disk
    auto sizeOnDisk =
        file::getSizeOnDisk(osPath, object.size(), object.attrib());

    // If we coudn't get it, use the same logical size
    if (sizeOnDisk.check()) {
        // Use the logical size
        object.storeSize(object.size());
    } else {
        // If it is different...
        if (object.storeSize() != *sizeOnDisk) {
            object.markChanged(LogLevel, "Storage size is different");
            object.storeSize(*sizeOnDisk);
        }
    }

    return {};
}
}  // namespace engine::store::filter::filesys::base
