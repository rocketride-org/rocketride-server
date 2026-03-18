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

namespace engine::task::actionCopy {

//-----------------------------------------------------------------
/// @details
///		Setup for a copy operation
//-----------------------------------------------------------------
Error Task::beginTask() noexcept {
    if (auto ccode = Parent::beginTask()) return ccode;

    // reset target update flag
    LOGT("Setting update flag as `unknown` for the copy action");
    m_targetEndpoint->config.exportUpdateBehavior =
        EXPORT_UPDATE_BEHAVIOR::UNKNOWN;
    m_targetEndpoint->config.exportUpdateBehaviorName = "unknown";

    return {};
}

//-----------------------------------------------------------------
/// @details
///		Copy an entry from the source to the target
/// @param[in] entry
///		The entry to copy
//-----------------------------------------------------------------
Error Task::processItem(Entry &entry) noexcept {
    // Copy it
    if (auto ccode = Parent::processItem(entry)) return ccode;

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
        if (auto ccode = Parent::writeResult('A', entry)) return ccode;
    }

    // And done
    return {};
}
}  // namespace engine::task::actionCopy
