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

#include <engLib/eng.h>

namespace engine::store::filter::outlook {
using namespace utility;

//---------------------------------------------------------------------
/// @details
///		Determines existence of the entry
///	@param[in]	object
///		The entry object that should be stat-ed
///	@returns
///		ErrorOr<bool>
///         - where
///             Error if there are some errors
///             true  if file was deleted (couldn't be stat: entry doesn't
///             exist, is a directory not a file) false if entry exists is a
///             file
//---------------------------------------------------------------------
ErrorOr<bool> IFilterInstance::stat(Entry &object) noexcept {
    // Get path
    auto fullPath = object.url().path();
    // Get username, format is /username/path
    Text userName = fullPath.at(USERNAME_POS);
    if (auto ccode = getClient()) {
        return true;
    }
    // get the message parent
    auto ccode = m_msEmailNode->getMessageParent(userName, object.uniqueName());
    if (ccode.hasCcode()) {
        // failed
        return true;
    }
    // parentId
    Text parentId = ccode.value();
    Text pathValue;
    // get the map of folders
    // the map will be created for a user, if map was already present use it
    // else create a new one create a new map for a new user
    {
        // acquire lock
        std::unique_lock lock{endpoint.getPathLock()};
        auto &foldersInfo = endpoint.getFolderMap();
        auto &folderMap = foldersInfo.m_folders;
        if (foldersInfo.m_userName.empty() ||
            foldersInfo.m_userName != userName) {
            folderMap.clear();
            if (auto ccode =
                    m_msEmailNode->getValidPaths(userName, folderMap)) {
                return true;
            }
            // set username
            foldersInfo.m_userName = userName;
        }
        auto it = folderMap.find(parentId);
        if (it == folderMap.end()) return true;

        pathValue = folderMap.at(parentId);
    }
    Text actualPath = pathValue + "/" + object.name();

    // return false in case of match
    return !(0 == Utf8icmp(object.path(), actualPath));
};

};  // namespace engine::store::filter::outlook