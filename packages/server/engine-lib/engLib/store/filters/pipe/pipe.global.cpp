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

namespace engine::store::filter::pipe {
//-------------------------------------------------------------------------
/// @details
///     In the PIPELINE mode, Loads the Python module 'ai.web.metrics',
///     stores it in the member variable `m_metrics`. If the module is
///     available, it calls the `taskMetricsBegin` function to indicate
///     the start of a task. If the module or function is unavailable,
///     the call is skipped silently.
/// @retval Error
///     Returns an error if the Python interaction fails, or success otherwise.
//-------------------------------------------------------------------------
Error IFilterGlobal::beginFilterGlobal() noexcept {
    endpoint->config.jobConfig.lookupAssign("taskId", m_taskId);

    if (m_openMode == OPEN_MODE::PIPELINE) {
        LOGT("Task metrics load");
        auto python = localfcn {
            // Import and store the Python metrics module
            m_metrics = py::module::import("ai.web.metrics");
        };
        if (auto ccode = callPython(python)) return ccode;

        LOGT("Task metrics begin");
        if (auto ccode = callMetrics("taskMetricsBegin")) return ccode;
    }

    return {};
}

//-------------------------------------------------------------------------
/// @details
///     In the PIPELINE mode, calls the Python function `taskMetricsEnd`
///     from the previously loaded module `ai.web.metrics`. Used to indicate
///     the ending of a pipeline task operation. If the module or function is
///     unavailable, the call is skipped silently.
/// @retval Error
///     Returns an error if the Python interaction fails, or success otherwise.
//-------------------------------------------------------------------------
Error IFilterGlobal::endFilterGlobal() noexcept {
    if (m_openMode == OPEN_MODE::PIPELINE) {
        LOGT("Task metrics end");
        if (auto ccode = callMetrics("taskMetricsEnd")) return ccode;
    }

    return {};
}

//-------------------------------------------------------------------------
/// @details
///     Calls the Python function `taskMetricsObjectBegin` from the previously
///     loaded module `ai.web.metrics`. Used to indicate the start of a
///     pipeline operation. If the module or function is unavailable,
///     the call is skipped silently.
/// @retval Error
///     Returns an error if the Python interaction fails, or success otherwise.
//-------------------------------------------------------------------------
Error IFilterGlobal::beginObjectMetrics(size_t pipeId, Entry &entry) noexcept {
    LOGT("Task metrics object begin");
    return callMetrics("taskMetricsObjectBegin", pipeId, &entry);
}

//-------------------------------------------------------------------------
/// @details
///     Calls the Python function `taskMetricsObjectEnd` from the previously
///     loaded module `ai.web.metrics`. Used to indicate the end of a
///     pipeline operation. If the module or function is unavailable,
///     the call is skipped silently.
/// @param[in] entry
///     The entry object that contains the metrics data.
/// @retval Error
///     Returns an error if the Python interaction fails, or success otherwise.
//-------------------------------------------------------------------------
Error IFilterGlobal::endObjectMetrics(size_t pipeId, Entry &entry) noexcept {
    LOGT("Task metrics object end");
    return callMetrics("taskMetricsObjectEnd", pipeId, &entry);
}

//-------------------------------------------------------------------------
/// @details
///     Calls a specified Python hook function with the task ID and an optional
///     entry object. This is used to interact with the metrics module in
///     PIPELINE mode. If the metrics module is not loaded or the task ID is
///     not set, an error is returned.
/// @param[in] hookName
///     The name of the Python hook function to call.
/// @param[in] pipeId
///     An optional ID of the pipe to use for the hook function.
/// @param[in] entry
///     An optional entry object to pass to the hook function.
/// @retval Error
///     Returns an error if the operation is not in PIPELINE mode, if the task
///     ID
//-------------------------------------------------------------------------
Error IFilterGlobal::callMetrics(const Text &hookName, size_t pipeId,
                                 Entry *entry) noexcept {
    if (m_openMode != OPEN_MODE::PIPELINE)
        return APERR(Ec::InvalidCommand,
                     "Metrics can only be used in PIPELINE mode");

    if (!m_taskId)
        return APERR(Ec::InvalidParam, "Task ID is required for metrics");

    auto python = localfcn {
        // Check if the metrics module is loaded
        if (!m_metrics) return;

        // Get the hook function
        py::function hook = m_metrics.attr(hookName);
        if (!hook) return;

        // Call the hook with the task ID and pipeId, entry if specified
        if (entry)
            hook(m_taskId, pipeId, *entry);
        else
            hook(m_taskId);
    };

    return callPython(python);
}
}  // namespace engine::store::filter::pipe
