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
//	Example C++ node filter
//
//-----------------------------------------------------------------------------
#include "cppExample.hpp"

namespace nodes::cppExample {
//-------------------------------------------------------------------------
/// @details
/// 	Starts a new object - resets the tag counter.
///	@param[in]	object
///		The object information about the object being opened
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::open(Entry &object) noexcept {
    LOGPIPE();

    m_tagCount = 0;
    return Parent::open(object);
}

//-------------------------------------------------------------------------
/// @details
/// 	Counts the tag and passes it down the stack untouched.
///	@param[in]	pTag
///		The tag to write
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::writeTag(const TAG *pTag) noexcept {
    LOGPIPE();

    m_tagCount++;
    return Parent::writeTag(pTag);
}

//-------------------------------------------------------------------------
/// @details
/// 	Reports what the object carried before closing.
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::close() noexcept {
    LOGPIPE();

    LOGT("Example node counted {} tags", m_tagCount);
    return Parent::close();
}

}  // namespace nodes::cppExample
