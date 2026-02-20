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

namespace engine::task::scan::console {
//-------------------------------------------------------------------------
/// @details
///     This function is called when an endpoint scanner has found an
///		object to add or a container to add to the processing list
/// @param[in]  context
///     Context we are flushing
///	@param[in]	object
///		The object to write or container to process
//-------------------------------------------------------------------------
Error Task::ScanConsole::addScanObject(ScanContext &context, Entry &object,
                                       const Path &objectPath) noexcept {
    // Output the object
    LOGX(Lvl::Always, objectPath);

    // Adjust the size
    context.objectCount += {1, object.isObject() ? object.size() : 0};

    // Add this batch to the total
    MONITOR(addCompleted, 1, object.isObject() ? object.size() : 0);

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Setup the task
//-------------------------------------------------------------------------
Error Task::beginTask() noexcept { return {}; }

//-------------------------------------------------------------------------
/// @details
///		Execute the scan job
//-------------------------------------------------------------------------
Error Task::exec() noexcept {
    // Only one key
    auto serviceConfig = taskConfig().lookup("service");

    // Create an endpoint
    m_sourceEndpoint =
        IServiceEndpoint::getSourceEndpoint({.jobConfig = jobConfig(),
                                             .taskConfig = taskConfig(),
                                             .serviceConfig = serviceConfig,
                                             .openMode = OPEN_MODE::SOURCE});
    if (!m_sourceEndpoint) return m_sourceEndpoint.ccode();

    return m_scanner.scan(*m_sourceEndpoint);
}
}  // namespace engine::task::scan::console
