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

//-----------------------------------------------------------------------------
//
//	Defines the segmented read/write functions. These are for getting
//  and putting data into the IO buffer on segmented files in the rocketride
//  format.
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::filesys::base {
//---------------------------------------------------------------------
/// @details
///		Determines existence of the entry
///	@param[in]	entry
///		The entry that should be stat-ed
///	@returns
///		ErrorOr<bool>
///         - where
///             Error if there are some errors
///             true  if file was deleted (couldn't be stat: entry doesn't
///             exist, is a directory not a file) false if entry exists is a
///             file
//---------------------------------------------------------------------
template <log::Lvl LvlT>
ErrorOr<bool> IBaseInstance<LvlT>::stat(Entry &entry) noexcept {
    Text path;
    if (auto ccode = Url::osPath(entry.url(), path)) return ccode;

    auto errorOrStatInfo = ap::file::stat(path);
    if (errorOrStatInfo.hasCcode()) {
        auto &errorCode = errorOrStatInfo.ccode();
        if (Parent::isFileMovedOrUnavailable(errorCode)) {
            LOGT("File is unavailable", path);
            return true;
        }

        LOG(Always, "Unrecognized error code", errorCode,
            "received while processing file", path);
        return false;
    }

    ap::file::StatInfo statInfo = *errorOrStatInfo;

    if (statInfo.isDir) {
        if (!m_endpoint.m_excludeSymlinks && entry.objectTags &&
            entry.objectTags().isMember("symlink")) {
            LOGT("Repeat", statInfo.isLink ? "symlink" : "directory",
                 "is treated as an object and exists", path);
            return false;
        }
        LOGT("File not exists as it is a directory", path);
        return true;
    }

    if (statInfo.isOffline) {
        LOGT("File is offline", path);
        return true;
    }

    LOGT("File exists", path);
    return false;
};

//-------------------------------------------------------------------------
/// @details
///		Checks whether the file exists, and should be replaced if exists.
///     Existent file is not updated when either `update` option is set to
///     `skip`, or when `update` option is set to `update`, and the modification
///     time is equal to the modification time of the file. In all other cases
///     file is created (if doesn't exist) or updated. If object needs to be
///     skipped, object's completion code is set to `Ec::Skipped` and should be
///     processed further
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseInstance<LvlT>::isObjectUpdateNeeded(const Url &url) noexcept {
    if (endpoint->config.exportUpdateBehavior ==
        EXPORT_UPDATE_BEHAVIOR::UNKNOWN)
        return {};

    // Get the os based path
    Error ccode;
    Text osPath;
    if (ccode = Url::osPath(url, osPath)) return ccode;
    LOGT("Checking existence of file:", osPath);

    auto errorOrStatInfo = ap::file::stat(osPath);
    if (errorOrStatInfo
            .hasCcode())  // if it is impossible to stat -> return success
        return {};

    if (endpoint->config.exportUpdateBehavior == EXPORT_UPDATE_BEHAVIOR::SKIP) {
        LOGT("Skipping existent file:", osPath);
        currentEntry->completionCode(
            APERR(Ec::Skipped, "Skipping existent file", osPath));
        return {};
    }

    if (endpoint->config.exportUpdateBehavior ==
        EXPORT_UPDATE_BEHAVIOR::UPDATE) {
        auto mtimeSys =
            time::fromTimeT<time::SystemStamp>(currentEntry->modifyTime());
        ap::file::StatInfo statInfo = *errorOrStatInfo;

        if (mtimeSys != statInfo.modifyTime) {
            LOGT("Timestamp different: destination", statInfo.modifyTime,
                 ", source", mtimeSys);
            return {};
        }

        LOGT("Timestamp is the same for source and destination",
             statInfo.modifyTime, ", skipping");
        currentEntry->completionCode(
            APERR(Ec::Skipped, "Timestamp the same:", mtimeSys));
        return {};
    }

    LOGT("Unexpected value for `update` flag, doing rewrite");
    return {};
}

}  // namespace engine::store::filter::filesys::base
