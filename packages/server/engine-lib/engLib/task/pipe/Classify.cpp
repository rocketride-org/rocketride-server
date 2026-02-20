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

namespace engine::task::classify {

//-----------------------------------------------------------------
/// @details
///		Setup the operation
//-----------------------------------------------------------------
Error Task::beginTask() noexcept {
    // Get context
    json::Value &config = taskConfig();
    if (auto ccode = config.lookupAssign("wantsContext", m_wantsContext))
        return ccode;

    // Get a null source endpoint (no .serviceConfig specified)
    if (!(m_sourceEndpoint = IServiceEndpoint::getSourceEndpoint(
              {.jobConfig = jobConfig(),
               .taskConfig = config,
               .openMode = OPEN_MODE::INDEX})))
        return m_sourceEndpoint.ccode();

    // Get a null target endpoint (no .serviceConfig specified)
    if (!(m_targetEndpoint = IServiceEndpoint::getTargetEndpoint(
              {.jobConfig = jobConfig(),
               .taskConfig = config,
               .openMode = OPEN_MODE::CLASSIFY})))
        return m_targetEndpoint.ccode();

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
    // Process for C*{...} lines
    return Parent::processLine("C"_tv, line, parent);
}

//-----------------------------------------------------------------
/// @details
///		Process the enry
/// @param[in] entry
///		The entry to copy
//-----------------------------------------------------------------
Error Task::processItem(Entry &entry) noexcept {
    // Allocate/release the source pipe
    ErrorOr<ServicePipe> sourcePipe;
    util::Guard pipes{[&] { sourcePipe = m_sourceEndpoint->getPipe(); },
                      [&] {
                          if (sourcePipe)
                              m_sourceEndpoint->putPipe(*sourcePipe);
                      }};

    // The app sends over the classificationId field indicating whether or
    // not the object is currently classified.
    // If we need to classify the entry and it isn't yet,
    //		return the classifications[] info
    // If we don't want it classified
    //		return nothing for classifications[]

    // Get a source pipe
    if (!sourcePipe) return sourcePipe.ccode();

    // If we are supposed to classify this
    if (entry.flags() & Entry::FLAGS::CLASSIFY) {
        // Classify if wantsContext or never classified
        if (m_wantsContext || !entry.classificationId()) {
            // Process this item
            if (auto ccode = Parent::processItem(entry, *sourcePipe))
                return ccode;

            // Say we changed
            entry.changed(true);
        }
    } else {
        // We don't want to be classified, if we are
        if (entry.classificationId()) {
            // Indicate the entry has changed
            entry.changed(true);
        }
    }

    // We never need to send this back
    entry.classificationId.reset();

    // If we failed or not...
    if (entry.objectFailed()) {
        // Add it to the failed
        MONITOR(addFailed, 1, entry.size());

        // Always write the error
        if (auto ccode = Parent::writeError(entry, entry.completionCode()))
            return ccode;
    } else {
        // Add it to the completed
        MONITOR(addCompleted, 1, entry.size());

        // If the entry is changed, write it to the output pipe
        if (entry.changed()) {
            // Write the result
            if (auto ccode = Parent::writeResult('C', entry)) return ccode;
        }
    }
    // And done
    return {};
}
}  // namespace engine::task::classify
