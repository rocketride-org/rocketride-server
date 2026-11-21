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

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Writes a text string to the task output if it has been allowed
///		to do so. The task is read and called under m_taskLock: after
///		endEndpoint() no task is bound, and the text is dropped; the first
///		write dropped after the end logs a warning.
///	@param[in]	text
///		The text to write
///	@returns
///		Error, empty when no task is bound
//-------------------------------------------------------------------------
Error IServiceEndpoint::taskWriteText(const Text &text) noexcept {
    std::lock_guard<async::Mutex> lock(m_taskLock);
    if (m_task)
        return m_task->writeText(text);
    logDroppedTaskWrite("text");
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Writes a warning about an object to the monitor. The task is
///		read and called under m_taskLock: after endEndpoint() no task is
///		bound, and the warning is dropped; the first write dropped after
///		the end logs a warning.
///	@param[in]	entry
///		The entry to log against
///	@param[in]	ccode
///		The message to log
///	@returns
///		Error, empty when no task is bound
//-------------------------------------------------------------------------
Error IServiceEndpoint::taskWriteWarning(const Entry &entry,
                                         const Error &ccode) noexcept {
    std::lock_guard<async::Mutex> lock(m_taskLock);
    if (m_task)
        return (m_task->writeWarning)(entry, ccode);
    logDroppedTaskWrite("warning");
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Called under m_taskLock by a task write that found no task bound.
///		Once the end has started, the first such write of this endpoint
///		logs a warning that names the endpoint and the kind of write; the
///		later ones are dropped without a line. A write before the end logs
///		nothing: an endpoint that is not a task's target never has a task
///		bound. The written text is never logged, as it can carry document
///		content.
///	@param[in]	kind
///		The kind of write: "text" or "warning"
//-------------------------------------------------------------------------
void IServiceEndpoint::logDroppedTaskWrite(const char *kind) noexcept {
    if (!m_ending || m_droppedTaskWriteLogged)
        return;
    m_droppedTaskWriteLogged = true;
    LOG(Always, "Warning: teardown: task", kind,
        "written after the end of endpoint", config.logicalType,
        "is dropped; later task writes of this endpoint are dropped",
        "without a log line");
}

//-------------------------------------------------------------------------
/// @details
///		Sets the task that taskWriteText() and taskWriteWarning() write
///		to, under m_taskLock. endEndpoint() clears it.
///	@param[in]	pTask
///		The task, or nullptr to let go of the bound one
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::bindTask(task::IPipeTaskBase *pTask) noexcept {
    std::lock_guard<async::Mutex> lock(m_taskLock);
    m_task = pTask;
    return {};
}
}  // namespace engine::store
