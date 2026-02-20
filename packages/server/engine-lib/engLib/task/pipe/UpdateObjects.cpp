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

namespace engine::task::updateObjects {

//-----------------------------------------------------------------
/// @details
///		Setup the operation
//-----------------------------------------------------------------
Error Task::beginTask() noexcept {
    // Get our service config
    auto serviceConfig = taskConfig()["service"];

    // Get an endpoint
    if (!(m_sourceEndpoint = IServiceEndpoint::getSourceEndpoint(
              {.jobConfig = jobConfig(),
               .taskConfig = taskConfig(),
               .serviceConfig = serviceConfig,
               .openMode = OPEN_MODE::SOURCE})))
        return m_sourceEndpoint.ccode();

    // Init our selection info
    auto selections = m_sourceEndpoint->initSelections();
    if (!selections) return selections.ccode();

    // And do the parent setup
    if (auto ccode = Parent::beginTask()) return ccode;

    // We only need 1 thread for this. Prevents interleaving...
    setThreadCount(1);
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Destruct the operation
//-----------------------------------------------------------------
Error Task::endTask() noexcept {
    // And continue with the parent
    return Parent::endTask();
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
    // Process for I*{...} lines
    return Parent::processLine("S"_tv, line, parent);
}

//-----------------------------------------------------------------
/// @details
///		Process the enry
/// @param[in] entry
///		The entry to copy
//-----------------------------------------------------------------
Error Task::processItem(Entry &entry) noexcept {
    // Get the current path
    Path path;
    if (auto ccode = Url::toPath(entry.url(), path)) return ccode;

    // If we are excluded, skip it
    uint32_t flags = 0;
    if (!m_sourceEndpoint->isIncluded(path, flags)) return {};

    // If we are supposed to classify this but it has no classificationId (means
    // was not classified) or if we are supposed to index this but it has no
    // wordBatchId (means was not indexed) or if we are supposed to get
    // permissions this but it has no permissionId (means - not get through
    // permissions) or if we are supposed to vectorize this but it has no
    // vectorBatchId (means was not vectorized) or if flags are changed then we
    // need to put this object into the pipe
    bool putIntoPipe =
        ((entry.flags() & Entry::FLAGS::CLASSIFY) &&
         !entry.classificationId()) ||
        ((entry.flags() & Entry::FLAGS::INDEX) && !entry.wordBatchId()) ||
        ((entry.flags() & Entry::FLAGS::PERMISSIONS) &&
         !entry.permissionId()) ||
        ((entry.flags() & Entry::FLAGS::VECTORIZE) && !entry.vectorBatchId()) ||
        flags != entry.flags();

    if (!putIntoPipe) {
        // Add it to the completed
        MONITOR(addCompleted, 1, entry.size());
        return {};
    }

    // Update the flags and restore OCR_DONE flag if needed
    bool ocrDoneFlag = entry.flags() & Entry::FLAGS::OCR_DONE;
    entry.flags(flags);
    if (ocrDoneFlag) entry.flags(entry.flags() | Entry::FLAGS::OCR_DONE);

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

        // Write the result
        if (auto ccode = Parent::writeResult('S', entry)) return ccode;
    }

    // And done
    return {};
}
}  // namespace engine::task::updateObjects
