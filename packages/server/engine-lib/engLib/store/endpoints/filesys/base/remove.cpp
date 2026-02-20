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
//-----------------------------------------------------------------
/// @details
///		Removes the entry
///	@param[in] entry
///		The entry to remove
///	@returns
///		Error
//-----------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseInstance<LvlT>::removeObject(Entry &entry) noexcept {
    // Create the target path
    if (auto ccode = endpoint->mapPath(entry.url(), m_targetObjectUrl))
        return ccode;

    if (!m_endpoint.m_excludeSymlinks && entry.objectTags &&
        entry.objectTags().isMember("symlink")) {
        bool isSymlink = false;
        if (auto ccode = entry.objectTags().lookupAssign("symlink", isSymlink))
            return ccode;

        entry.completionCode(
            APERR(Ec::Skipped, "Deleting not supported: repeated",
                  isSymlink ? "symlink" : "directory", entry.url()));
        return {};
    }

    // Get it's path
    Text path;
    if (auto ccode = Url::osPath(entry.url(), path)) return ccode;

    // Validate file path
    if (!ap::file::exists(path)) {
        entry.completionCode(APERR(Ec::Unexpected, "Path does not exist",
                                   (TextView)m_targetObjectUrl));
        return {};
    }

    if (!ap::file::isFile(path)) {
        entry.completionCode(APERR(Ec::Unexpected, "Object is not a file",
                                   (TextView)m_targetObjectUrl));
        return {};
    }

    // Remove file
    if (auto ccode = ap::file::remove(path)) entry.completionCode(ccode);

    return {};
}
}  // namespace engine::store::filter::filesys::base
