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
    Error ccode;

    // Get the os path
    Text osPath;
    if (ccode = Url::osPath(object.url(), osPath)) return ccode;

    auto statOr = ap::file::stat(osPath, true);
    if (!statOr) return statOr.ccode();

    auto stat = _mv(*statOr);

    // Defaut to no change
    object.changed(false);

    // Check the create time
    if (object.createTime.get() != stat.createTime) {
        object.markChanged(LogLevel, "Creation time different");
        object.createTime(stat.createTime);
    }

    // Check the access time (but don't consider it changed)
    if (object.accessTime.get() != stat.accessTime) {
        object.accessTime(stat.accessTime);
    }

    // Check the modify time
    if (object.modifyTime.get() != stat.modifyTime) {
        object.markChanged(LogLevel, "Modification time different");
        object.modifyTime(stat.modifyTime);
    }

    // Check the attributes - might want to limit this to a subset
    if (object.attrib() != stat.plat.st_mode) {
        object.markChanged(LogLevel, "Attributes have changed");
        object.attrib(stat.plat.st_mode);
    }

    // Get the size
    if (object.size() != stat.size) {
        object.markChanged(LogLevel, "Size is different");
        object.size(stat.size);
    }

    // Get the size on disk
    if (object.storeSize() != stat.sizeOnDisk) {
        object.markChanged(LogLevel, "Size on disk is different");
        object.storeSize(stat.sizeOnDisk);
    }

    return {};
}
}  // namespace engine::store::filter::filesys::base
