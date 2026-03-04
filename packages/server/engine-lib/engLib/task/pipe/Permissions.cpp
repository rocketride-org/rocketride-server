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

namespace engine::task::permissions {

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
               .openMode = OPEN_MODE::TARGET})))
        return m_targetEndpoint.ccode();

    // And do the parent setup
    return Parent::beginTask();
}

//-----------------------------------------------------------------
/// @details
///		Get number of processing threads
/// @param[in] currentThreadCount
///     The current thread count
/// @return
///		The number of threads to use for processing the entries
//-----------------------------------------------------------------
uint32_t Task::getThreadCount(uint32_t currentThreadCount) const noexcept {
    // Allocate/release the source pipe
    ErrorOr<ServicePipe> sourcePipe;
    util::Guard pipes{[&] { sourcePipe = m_sourceEndpoint->getPipe(); },
                      [&] {
                          if (sourcePipe)
                              m_sourceEndpoint->putPipe(*sourcePipe);
                      }};

    // Get a source pipe
    if (!sourcePipe) return currentThreadCount;

    return sourcePipe->getThreadCount(currentThreadCount);
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
    return Parent::processLine("O"_tv, line, parent);
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

    // Get a source pipe
    if (!sourcePipe) return sourcePipe.ccode();

    // the contract in the permission task:
    // https://rocketride.atlassian.net/browse/APPLAT-9838?focusedCommentId=48788
    // If permissions are not enabled
    if (!(entry.flags() & Entry::FLAGS::PERMISSIONS)) {
        // Add it to the completed
        MONITOR(addCompleted, 1, entry.size());
        entry.permissionId.reset();
        // Write the result
        if (auto ccode = Parent::writeResult('O', entry)) return ccode;
        return {};
    }

    // Check the object for a change
    Error objcode = sourcePipe->checkPermissions(entry);

    if (objcode) {
        // This is a failure for the object
        entry.completionCode(objcode);
    } else {  // If the entry is changed
        // Need to check this iFlags to restore already scanned and deleted
        // files (entry was first included, then excluded and now included
        // back), otherwise they will be marked as "deleted" in DB forever
        if (entry.iflags() & Entry::IFLAGS::DELETED) {
            // does not make any sence but nice to have -> App controls that
            // iFlags anyway
            entry.iflags(entry.iflags() & ~Entry::IFLAGS::DELETED);
            // Mark entry changed to write the result
            entry.changed(true);
        }
    }

    // If we failed or not...
    if (entry.objectFailed()) {
        // reset completion code if file exists (not an error)
        if (entry.completionCode() == Ec::Skipped) {
            MONITOR(addCompleted, 1, entry.size());
            LOGT("Export of entry", entry.url(), "skipped");
            entry.completionCode({});
        } else {
            MONITOR(addFailed, 1, entry.size());
            // Write the error
            if (auto ccode = Parent::writeError(entry, entry.completionCode()))
                return ccode;
        }
    } else {
        // Add it to the completed
        MONITOR(addCompleted, 1, entry.size());

        // If the entry is changed, write it to the output pipe
        if (entry.changed()) {
            // Write the result
            if (auto ccode = Parent::writeResult('O', entry)) return ccode;
        }
    }

    // And done
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Process the enry
/// @param[in] entries
///		The entries to process
//-----------------------------------------------------------------
ErrorOr<size_t> Task::processItems(std::vector<Entry> &entries) noexcept {
    // Allocate/release the source pipe
    ErrorOr<ServicePipe> sourcePipe;
    util::Guard pipes{[&] { sourcePipe = m_sourceEndpoint->getPipe(); },
                      [&] {
                          if (sourcePipe)
                              m_sourceEndpoint->putPipe(*sourcePipe);
                      }};

    // Get a source pipe
    if (!sourcePipe) return sourcePipe.ccode();

    // Process entries without permissions and remove them from the vector, do
    // it when there are entries to process
    if (!entries.empty()) {
        for (auto it = entries.begin(); it != entries.end();) {
            // the contract in the permission task:
            // https://rocketride.atlassian.net/browse/APPLAT-9838?focusedCommentId=48788
            // If permissions are not enabled
            if (!(it->flags() & Entry::FLAGS::PERMISSIONS)) {
                // Add it to the completed
                MONITOR(addCompleted, 1, it->size());
                it->permissionId.reset();
                // Write the result
                if (auto ccode = Parent::writeResult('O', *it)) return ccode;
                // Remove the entry from the vector
                it = entries.erase(it);
            } else {
                ++it;
            }
        }

        // If no entries left after removing those without permissions, inform
        // the caller
        if (entries.empty()) return _cast<size_t>(0);
    }

    // Check the object for a change
    auto processingResult = sourcePipe->checkPermissions(entries);

    if (processingResult.hasCcode()) return processingResult;

    for (auto &entry : entries) {
        // If the entry is changed
        // Need to check this iFlags to restore already scanned and deleted
        // files (entry was first included, then excluded and now included
        // back), otherwise they will be marked as "deleted" in DB forever
        if (entry.iflags() & Entry::IFLAGS::DELETED) {
            // does not make any sence but nice to have -> App controls that
            // iFlags anyway
            entry.iflags(entry.iflags() & ~Entry::IFLAGS::DELETED);
            // Mark entry changed to write the result
            entry.changed(true);
        }

        // TODO: next block looks generic, and it may be a good idea to move it
        // to the parent class If we failed or not...
        if (entry.objectFailed()) {
            // reset completion code if file exists (not an error)
            if (entry.completionCode() == Ec::Retry)
                continue;  // do nothing on retry, handled upper level

            if (entry.completionCode() == Ec::Skipped) {
                // Add it to the completed
                MONITOR(addCompleted, 1, entry.size());
                LOGT("Export of entry", entry.url(), "skipped");
                entry.completionCode({});
                continue;
            } else {
                // Add it to the failed
                MONITOR(addFailed, 1, entry.size());
                // Write the error
                if (auto ccode =
                        Parent::writeError(entry, entry.completionCode()))
                    return ccode;
            }
        } else {
            // Add it to the completed
            MONITOR(addCompleted, 1, entry.size());

            // If the entry is changed, write it to the output pipe
            if (entry.changed()) {
                // Write the result
                if (auto ccode = Parent::writeResult('O', entry)) return ccode;
            }
        }
    }

    // And done
    return processingResult;
}

Error Task::endTask() noexcept {
    // If we have an endpoint
    if (m_sourceEndpoint) {
        // write permissions
        {
            // Allocate/release the source pipe
            ErrorOr<ServicePipe> sourcePipe;
            util::Guard pipes{[&] { sourcePipe = m_sourceEndpoint->getPipe(); },
                              [&] {
                                  if (sourcePipe)
                                      m_sourceEndpoint->putPipe(*sourcePipe);
                              }};

            auto ccode = sourcePipe->outputPermissions();
            if (ccode.hasCcode()) return ccode.ccode();

            if (ccode.hasValue()) {
                const std::list<Text> &perms = ccode.value();
                for (const auto &it : perms) {
                    if (auto ccode = Parent::writeText(it)) return ccode;
                }
            }
        }
    }

    // Call the parent
    return Parent::endTask();
}
}  // namespace engine::task::permissions
