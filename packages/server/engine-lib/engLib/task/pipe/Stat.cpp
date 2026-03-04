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

namespace engine::task::stat {

//-----------------------------------------------------------------
/// @details
///		Setup the operation
//-----------------------------------------------------------------
Error Task::beginTask() noexcept {
    // Get an endpoint
    if (!(m_sourceEndpoint = IServiceEndpoint::getSourceEndpoint(
              {.jobConfig = jobConfig(),
               .taskConfig = taskConfig(),
               .serviceConfig = taskConfig()["service"],
               .openMode = OPEN_MODE::SOURCE})))
        return m_sourceEndpoint.ccode();

    // Get an endpoint
    if (!(m_targetEndpoint = IServiceEndpoint::getTargetEndpoint(
              {.jobConfig = jobConfig(),
               .taskConfig = taskConfig(),
               .openMode = OPEN_MODE::STAT})))
        return m_targetEndpoint.ccode();

    // And do the parent setup

    // Get "deleted" flag of endpoint
    m_deleted = m_sourceEndpoint->config.serviceConfig.lookup<bool>("deleted");

    if (!m_deleted) {
        // Get the root paths of the selections
        // Endpoint keeps its own configuration, use it because it might be
        // modified, instead of `serviceConfig`
        if (auto ccode = m_sourceEndpoint->initSelections().check())
            return ccode;
    }

    return Parent::beginTask();
}

Error Task::endTask() noexcept {
    Error ccode;

    // Reset sync tokens if the service is deleted
    if (m_sourceEndpoint->isSyncEndpoint() && m_deleted)
        ccode = ccode || m_sourceEndpoint->resetScan();

    return Parent::endTask() || ccode;
}

//-----------------------------------------------------------------
///	@details
///		Calls the default line processing to create an entry
///		and queue it up
/// @param[in] line
///		The incoming line - json format
/// @param[in] parent
///		The current parent
//-----------------------------------------------------------------
ErrorOr<Entry> Task::processLine(TextView line, const Url &parent) noexcept {
    // Process for S*{...} lines
    return Parent::processLine("S"_tv, line, parent);
}

//-----------------------------------------------------------------
/// @details
///		Process the enry
/// @param[in] entry
///		The entry to process
//-----------------------------------------------------------------
Error Task::processItem(Entry &entry) noexcept {
    Path sourcePath;

    if (auto ccode = Url::toPath(entry.url(), sourcePath)) return ccode;

    // Entry is not in included path or the source is removed
    // mark it as 'R'
    uint32_t flags = 0;
    if (m_deleted || !m_sourceEndpoint->isIncluded(sourcePath, flags)) {
        // no includes - path not included - Zombie Paths
        if (auto ccode = Parent::writeResult('R', entry)) return ccode;

        return {};
    }

    // Allocate/release the source pipe
    ErrorOr<ServicePipe> sourcePipe;
    util::Guard pipes{[&] { sourcePipe = m_sourceEndpoint->getPipe(); },
                      [&] {
                          if (sourcePipe)
                              m_sourceEndpoint->putPipe(*sourcePipe);
                      }};

    // Get a source pipe
    if (!sourcePipe) return sourcePipe.ccode();

    auto errorOr = sourcePipe->stat(entry);
    if (errorOr.hasCcode()) return errorOr.ccode();

    // If we failed or not...
    if (entry.objectFailed()) {
        // Add it to the failed
        MONITOR(addFailed, 1, entry.size());

        // Write the error
        if (auto ccode = Parent::writeError(entry, entry.completionCode()))
            return ccode;
    } else {
        // Add it to the completed
        MONITOR(addCompleted, 1, entry.size());

        if (bool deleted = errorOr.value()) {
            // could not stat - could not stat - most probably deleted
            if (auto ccode = Parent::writeResult('D', entry)) return ccode;
        }
    }

    // And done
    return {};
}

}  // namespace engine::task::stat