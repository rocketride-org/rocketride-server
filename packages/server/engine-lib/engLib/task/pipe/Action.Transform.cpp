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

namespace engine::task::actionTransform {

//-----------------------------------------------------------------
/// @details
///		Setup for a transform operation
//-----------------------------------------------------------------
Error Task::beginTask() noexcept {
    // Get the target endpoint first, because the settings
    // for opening the source endpoint depend on the target endpoint
    if (!(m_targetEndpoint = IServiceEndpoint::getTargetEndpoint(
              {.jobConfig = jobConfig(),
               .taskConfig = taskConfig(),
               .serviceConfig = taskConfig()["target"],
               .openMode = OPEN_MODE::TRANSFORM})))
        return m_targetEndpoint.ccode();

    // Define the mode in which the source endpoint is to be opened
    OPEN_MODE sourceOpenMode{};
    if (m_targetEndpoint->config.taskConfig.lookup<bool>("wantsPolicies") ||
        m_targetEndpoint->config.taskConfig.lookup<bool>("wantsContext") ||
        m_targetEndpoint->config.taskConfig.lookup<bool>("wantsText")) {
        sourceOpenMode =
            m_targetEndpoint->config.taskConfig.lookup<bool>("wantsData")
                ? OPEN_MODE::SOURCE_INDEX
                : OPEN_MODE::INDEX;
    } else {
        sourceOpenMode = OPEN_MODE::SOURCE;
    }

    // Get the source endpoint
    if (!(m_sourceEndpoint = IServiceEndpoint::getSourceEndpoint(
              {.jobConfig = jobConfig(),
               .taskConfig = taskConfig(),
               .serviceConfig = taskConfig()["source"],
               .openMode = sourceOpenMode})))
        return m_sourceEndpoint.ccode();

    // And do the parent setup
    return Parent::beginTask();
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
    // Process for A*{...} lines
    auto entry = Parent::processLine("A"_tv, line, parent);
    if (entry.hasCcode()) return entry;
    // transform action needs classification -> so adjust the flags
    // correspondingly
    entry.value().flags(entry.value().flags() | Entry::FLAGS::INDEX |
                        Entry::FLAGS::CLASSIFY | Entry::FLAGS::OCR);
    return entry;
}

//-----------------------------------------------------------------
/// @details
///		Transform an entry to the target
/// @param[in] entry
///		The entry to process
//-----------------------------------------------------------------
Error Task::processItem(Entry &entry) noexcept {
    // Transform it
    if (auto ccode = Parent::processItem(entry)) return ccode;

    // The Transform action can run the Classification filter with the wantsText
    // flag, which causes entire text content of the file to be included in the
    // classification results and increases disk space consumption or network
    // load by the output batches. The output batches are not processed, so we
    // simply remove classifications from them.
    entry.classifications.reset();

    // If we failed or not...
    if (entry.objectFailed()) {
        // If object skipped
        if (entry.completionCode() == Ec::Skipped) {
            // Add it to the completed, and do not write the result
            MONITOR(addCompleted, 1, entry.size());

        } else {
            // Add it to the failed
            MONITOR(addFailed, 1, entry.size());

            // Write the error
            if (auto ccode = Parent::writeError(entry, entry.completionCode()))
                return ccode;
        }
    } else {
        // Add it to the completed
        MONITOR(addCompleted, 1, entry.size());

        // Write the result
        if (auto ccode = Parent::writeResult('A', entry)) return ccode;
    }

    // And done
    return {};
}
}  // namespace engine::task::actionTransform
