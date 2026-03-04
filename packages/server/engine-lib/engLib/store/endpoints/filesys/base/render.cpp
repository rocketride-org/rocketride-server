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
//-------------------------------------------------------------------------
/// @details
///		Store an object
///	@param[in]	target
///		the output channel
///	@param[in]	object
///		object information
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseInstance<LvlT>::renderObject(ServicePipe &target,
                                        Entry &object) noexcept {
    if (!m_endpoint.m_excludeSymlinks && object.objectTags &&
        object.objectTags().isMember("symlink")) {
        bool isSymlink = false;
        if (auto ccode = object.objectTags().lookupAssign("symlink", isSymlink))
            return ccode;

        object.completionCode(APERR(Ec::Skipped, "Skipping",
                                    isSymlink ? "symlink" : "directory",
                                    object.url()));
        return {};
    }

    return Parent::renderObject(target, object);
}
}  // namespace engine::store::filter::filesys::base
