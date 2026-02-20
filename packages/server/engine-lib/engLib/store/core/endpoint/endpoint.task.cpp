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

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Writes a text string to the task output if it has been allowed
///		to do so
///	@param[in]	text
///		The text to write
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::taskWriteText(const Text &text) noexcept {
    if (m_task) return m_task->writeText(text);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Writes a warning about an object to the monitor
///	@param[in]	entry
///		The entry to log against
///	@param[in]	ccode
///		The message to log
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::taskWriteWarning(const Entry &entry,
                                         const Error &ccode) noexcept {
    if (m_task) return (m_task->writeWarning)(entry, ccode);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Sets the bound callbacks into the task
///	@param[in]	bindTask
///		Pointers to the callback functions
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::bindTask(task::IPipeTaskBase *pTask) noexcept {
    m_task = pTask;
    return {};
}
}  // namespace engine::store
