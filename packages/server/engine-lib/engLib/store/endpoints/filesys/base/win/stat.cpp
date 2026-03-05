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
//	Defines helper function for Stat task (for Windows)
//
//-----------------------------------------------------------------------------
#include <apLib/ap.h>
#include <engLib/eng.h>

namespace engine::store::filter::filesys::base {
//---------------------------------------------------------------------
/// @details
///		Check if error code corresponds to the situation when file was moved, or
/// permissions were changed
///	@param[in]	error
///		error
///	@returns
///		true if file was moved, or permissions were changed
template <log::Lvl LvlT>
inline bool IBaseSysInstance<LvlT>::isFileMovedOrUnavailable(
    const Error &err) noexcept {
    switch (err.code().value()) {
        case ERROR_FILE_NOT_FOUND:
        case ERROR_PATH_NOT_FOUND:
        case ERROR_ACCESS_DENIED:
            return true;
    }
    return false;
}
}  // namespace engine::store::filter::filesys::base