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

namespace engine::store::scan {
//-------------------------------------------------------------------------
/// @details
///     Add a directory to the work queue to be scanned
/// @param[in]  path
///     The path to scan
//-------------------------------------------------------------------------
Error Scanner::addScanContainer(Path &path) noexcept {
    // We need to queue this up into our work queue
    LOGTO(ScanContainers, "Adding container path to scan", path);
    return m_queue.push(_mv(path));
}

//-------------------------------------------------------------------------
/// @details
///     This function is called when an endpoint scanner has found an
///		object to add or a container to add to the processing list
/// @param[in]  context
///     Context we are flushing
///	@param[in]	object
///		The object to write or container to process
//-------------------------------------------------------------------------
Error Scanner::addEntry(ScanContext &context, Entry &object) noexcept {
    Path objectPath;

    if (scanProtocolCaps & Url::PROTOCOL_CAPS::SYNC) {
        // The object of sync endpoint MUST have an operation.
        if (!object.operation)
            return APERRT(Ec::InvalidState,
                          "Object operation is not set by sync endpoint");

        // The object of sync endpoint MUST have a name.
        if (!object.uniqueName)
            return APERRT(Ec::InvalidState,
                          "Object uniqueName is not set by sync endpoint");

        if (object.isObject() &&
            object.operation() != Entry::OPERATION::REMOVE && !object.changeKey)
            return APERRT(Ec::InvalidState,
                          "Object changeKey is not set by sync endpoint");

        // Put the object to the current object stack
        // Object might be modified during the call
        if (auto ccode = context.entryStack.push(
                object,
                m_directMode && scanProtocolCaps & Url::PROTOCOL_CAPS::SYNC,
                scanProtocol))
            return ccode;

        // Compute the name
        objectPath = _mv(context.entryStack.path());

        // Check whether the object is included and update the flags
        // accordingly. Do not check whether the container is included since it
        // may have children objects which are included. It's up to the App  to
        // remove the empty containers.
        if (object.isObject()) {
            uint32_t flags = 0;
            if (m_endpoint->isIncluded(objectPath, flags)) {
                // Update the flags of included object
                object.flags(flags);
            } else {
                if (context.entryStack.scanType() ==
                    Entry::SyncScanType::FULL) {
                    // Skip excluded object duing Full Sync Scan
                    return {};
                } else if (context.entryStack.scanType() ==
                           Entry::SyncScanType::DELTA) {
                    if (object.operation() != Entry::OPERATION::REMOVE)
                        // Mark excluded object as removed duing Delta Sync Scan
                        object.operation.set(Entry::OPERATION::REMOVE);
                } else {
                    return APERRT(Ec::OutOfRange, "Unknown Sync Scan Type:",
                                  context.entryStack.scanType());
                }
            }
        } else {
            // Skip the container on full re-scan for now in order to skip
            // output of the empty containers. This container is on the stack
            // and hence will be output, if any underlying objects come. Do not
            // skip if container is marked as deleted
            if (context.entryStack.scanType() == Entry::SyncScanType::FULL &&
                object.operation() != Entry::OPERATION::REMOVE)
                return {};
        }
    } else {
        // Compute the name
        objectPath = context.currentPath / object.name();

        // If this is a container, then, queue it up
        if (object.isContainer()) {
            // Skip it if excluded by the prefix as all sub-objects
            // of such container will be also skipped by this prefix
            if (m_endpoint->isExcludedByFileName(objectPath)) return {};

            // And submit it
            if (auto ccode = addScanContainer(objectPath))
                return APERRT(ccode, "Failed to submit", objectPath);

            // We don't write containers out to the output file
            return {};
        }

        // If we are excluded, skip it
        uint32_t flags = 0;
        if (!m_endpoint->isIncluded(objectPath, flags)) return {};

        // Setup the object action flags
        object.flags(flags);
    }

    // Helper lambda to write sync containers as objects as well
    const auto writeSyncContainers =
        localfcn(Entry & object, const Path &path)->Error {
        return addScanObject(context, object, path);
    };

    // If we are sync or not
    if (scanProtocolCaps & Url::PROTOCOL_CAPS::SYNC) {
        // Output the containers from the stack, which are not written yet
        if (auto ccode =
                context.entryStack.writeContainers(writeSyncContainers))
            return ccode;

        // Do not output the current container, as it is already output with
        // writeContainers
        if (object.isObject())
            // Output the current object
            if (auto ccode = addScanObject(context, object, objectPath))
                return ccode;
    } else {
        // Output the current object
        if (auto ccode = addScanObject(context, object, objectPath))
            return ccode;
    }

    // Update the counts and sizes
    _block() {
        auto lock = m_licenseLock.acquire();

        // Adjust the size
        m_accumCounts += {1, object.isObject() ? object.size() : 0};
    }

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Checks license limits - output a warning message to the
///     log and console if so
//-------------------------------------------------------------------------
Error Scanner::checkLicenseLimits() {
    // Check the counts
    if (!m_unlimitedCount && m_accumCounts.count >= m_licenseLimits.count) {
        // Output if we haven't output anything yet
        if (!m_licenseLimitReached) {
            m_licenseLimitReached = true;
            LOGT(
                "License limit reached: object count exceeded, current count "
                "{}, limit {}",
                m_accumCounts.count, m_licenseLimits.count);
            MONERR(warning, Ec::LicenseLimit, "File count limit reached.");
        }

        // Return the error
        return APERR(Ec::LicenseLimit, "File count limit reached.");
    }

    // Check the size
    if (!m_unlimitedSize && m_accumCounts.size >= m_licenseLimits.size) {
        // Output if we haven't output anything yet
        if (!m_licenseLimitReached) {
            m_licenseLimitReached = true;
            LOGT(
                "License limit reached: total objects size exceeded, current "
                "size {}, limit {}",
                m_accumCounts.size, m_licenseLimits.size);
            MONERR(warning, Ec::LicenseLimit,
                   "Total object size limit reached.");
        }

        // Return the error
        return APERR(Ec::LicenseLimit, "File size limit reached.");
    }

    // All ok
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Main scanner function that the scanner thread sits in, continually
///		grabs directories from the dir queue and processes the contents,
///		it does not recurse but instead relies on the dir walker to submit
///		all the dirs eventually
/// @param[in]  threadQueue
///		Receives a reference to our thread queue of paths to scan
//-------------------------------------------------------------------------
Error Scanner::scanContainer(ScanContext &context, Path &path) noexcept {
    bool urlValid = false;
    Url url;
    Error ccode;

    // Start/stop the counters
    util::Guard entryScope{[&] {
                               if (!Url::toUrl(scanProtocol, path, url)) {
                                   MONITOR(beginObject, (TextView)url, 0);
                                   urlValid = true;
                               }
                           },
                           [&] {
                               if (urlValid) MONITOR(endObject, (TextView)url);
                           }};

    // Save the path in the context
    context.currentPath = path;

    if (scanProtocolCaps & Url::PROTOCOL_CAPS::SYNC) {
        // Do nothing!
        // We write + line only once for sync endpoints
    } else {
        // If we write anything, write the + line
        context.outputContainer = true;
    }

    // Create the addObject callback and capture checkLicenseLimits explicitly
    const store::ScanAddObject addObject = [this,
                                            &context](Entry &object) -> Error {
        {
            // Check license limits before processing
            auto guard = m_lock.acquire();
            this->checkLicenseLimits();  // Call the checkLicenseLimits method

            if (m_licenseLimitReached)  // If limit is reached, stop further
                                        // processing
                return {};
        }
        return addEntry(context, object);  // Proceed if within limits
    };

    // Call the scanObject bound to this instance
    ccode = m_endpoint->scanObjects(context.currentPath, addObject);
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Main scanner function that the scanner thread sits in, continually
///		grabs directories from the dir queue and processes the contents,
///		it does not recurse but instead relies on the dir walker to submit
///		all the dirs eventually
/// @param[in]  threadQueue
///		Receives a reference to our thread queue of paths to scan
//-------------------------------------------------------------------------
Error Scanner::scanProcess() noexcept {
    Error ccode;

    // Allocate a new context
    std::unique_ptr<ScanContext> pContext{ScanContext::createInstance()};

    // Output the log message
    LOGT("Starting scan queue thread");

    // Now process some paths
    while (auto path = m_queue.pop()) {
        // If we got an error...
        if (!path) {
            if (path.ccode() != Ec::Completed) ccode = path.ccode();
            break;
        }

        // Output the log message
        LOGTO(ScanContainers, "Begin processing", path);
        if ((ccode = scanContainer(*pContext, *path))) {
            // Send the error to the monitor
            MONERR(error, ccode, "Scanning path failed", *path, ":", ccode);
        }

        // Output the log message
        LOGTO(ScanContainers, "End processing", path);
    }

    // Output the log message
    LOGT("Flushing final context");

    // Write out the remaining entries contained in our context
    _block() {
        auto guard = m_lock.acquire();
        if (ccode = flushContext(*pContext)) m_fatalError = ccode;
    }

    // Output the log message
    LOGT("Terminating scan queue thread");

    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Scan a service
//-------------------------------------------------------------------------
Error Scanner::scanService() noexcept {
    Error ccode;

    _block() {
        auto flushQueueGuard = util::Guard([&]() {
            // Wait until we're done
            LOGT("Waiting for scan queue completion on", scanProtocol);

            // Now, wait for the queue to become idle.  This is really defined
            // by the queue being empty, and all threads waiting for more
            // containers to be added, but since they are all waiting, no
            // containers will be added, so the queue can be flushed Skip queue
            // operations for NOINCLUDE nodes since they don't use the scan
            // queue
            if ((ccode = m_queue.waitForIdle()) &&
                !(scanProtocolCaps &
                  url::UrlConfig::PROTOCOL_CAPS::NOINCLUDE)) {
                // Log a message
                MONERR(warning, ccode,
                       "Unable to wait on endpoint queue completion",
                       scanProtocol);
            }

            // Wait until we're done
            LOGT("Flushing queue on", scanProtocol);

            // Flush the queue - we will need to restart it again for the next
            // service
            if ((ccode = m_queue.flush())) {
                // Log a message
                MONERR(warning, ccode, "Unable to flush endpoint queue",
                       scanProtocol);
            }
        });

        // Get the root paths of the selections
        // Endpoint keeps its own configuration, use it because it might be
        // modified, instead of `serviceConfig`
        auto selections = m_endpoint->initSelections();

        // If we had an error, done
        if (!selections) return selections.ccode();

        if (scanProtocolCaps & Url::PROTOCOL_CAPS::SYNC) {
            // Update the endpoint with the hash code of the selections
            uint32_t selectionHash = m_endpoint->getSelectionsHash();
            auto selectionToken = string::format("{,x,8}"_tv, selectionHash);
            LOGT("Selection token", selectionToken);
            if (auto ccode = m_endpoint->beginSyncScan(selectionToken))
                return ccode;
        }

        // If this does not support includes
        if (scanProtocolCaps & url::UrlConfig::PROTOCOL_CAPS::NOINCLUDE) {
            // Setup the everything path
            Path path = "/";

            // Log it
            LOGT("Scanning root {} on endpoint {}", path ? path : "/",
                 scanProtocol);

            // Add the path to the scan list
            if (auto ccode = addScanContainer(path)) return ccode;
        } else {
            // Get the paths
            auto paths = *selections;

            // Add the paths to the scan queue
            for (auto path : paths) {
                LOGT("Scanning root {} on endpoint {}", path ? path : "/",
                     scanProtocol);

                // Add the path to the scan list
                if (auto ccode = addScanContainer(path)) return ccode;
            }
        }
    }

    // Wait until we're done
    LOGT("Flush batch on", scanProtocol);

    _block() {
        // Acquire the mutex so we wait until all the threads have finished up
        auto guard = m_lock.acquire();

        // Flush the final batch
        if ((ccode = flushTask())) {
            // Log a message
            MONERR(warning, ccode, "Failed to flush endpoint batches");
        }
    }

    // Wait until we're done
    LOGT("Releasing endpoint", scanProtocol);

    if (scanProtocolCaps & Url::PROTOCOL_CAPS::SYNC) {
        if (auto ccode = m_endpoint->endSyncScan()) return ccode;
    }

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Scan the endpoint
//-------------------------------------------------------------------------
Error Scanner::scan(ServiceEndpoint endpoint) noexcept {
    Error ccode;

    // Save the endpoint to scan
    m_endpoint = endpoint;

    // Get references to our params
    auto &taskConfig = endpoint->config.taskConfig;
    auto &serviceConfig = endpoint->config.serviceConfig;

    // Look these up first as the lookupAssign will create the keys
    m_unlimitedCount = !taskConfig.isMember("maxObjectCountLimit") ||
                       taskConfig["maxObjectCountLimit"].isNull() ||
                       (taskConfig["maxObjectCountLimit"].isString() &&
                        taskConfig["maxObjectCountLimit"].asString().empty());
    m_unlimitedSize = !taskConfig.isMember("maxObjectSizeLimit") ||
                      taskConfig["maxObjectSizeLimit"].isNull() ||
                      (taskConfig["maxObjectSizeLimit"].isString() &&
                       taskConfig["maxObjectSizeLimit"].asString().empty());

    // Get the values
    if (auto ccode =
            (m_unlimitedCount
                 ? Error{}
                 : taskConfig.lookupAssign("maxObjectCountLimit",
                                           m_licenseLimits.count)) ||
            (m_unlimitedSize ? Error{}
                             : taskConfig.lookupAssign("maxObjectSizeLimit",
                                                       m_licenseLimits.size)) ||
            taskConfig.lookupAssign("threadCount", m_threadCount) ||
            serviceConfig.lookupAssign("type", scanProtocol) ||
            serviceConfig.lookupAssign("key", scanServiceKey))
        return ccode;

    // Save the service configuration
    m_service = serviceConfig;

    // Start the queues (note NO queue depth limit, to allow for recursion)
    auto start = time::now();

    // Get the capability flags of service
    if (auto ccode = Url::getCaps(scanProtocol, scanProtocolCaps)) return ccode;

    // Wait until we're done
    LOGT("Scanning service", scanProtocol);

    if ((scanProtocolCaps & Url::PROTOCOL_CAPS::SYNC) && m_threadCount > 1) {
        // The Sync node lists the object tree itself, and the Scan task
        // does not queue the containers found by the node. However,
        // the Scan task can queue multiple containers from included paths.
        // To keep the object tree consistent, the Scan task must process
        // these containers sequentially.
        LOGT("Reset scan thread count: 1");
        m_threadCount = 1;
    }

    // Check the thread count
    if (m_threadCount < 1 || m_threadCount > 64)
        return APERRT(Ec::InvalidState, "Invalid thread count", m_threadCount);

    LOGTT(Perf, "Thread count", Count(m_threadCount));

    // Start the queue with a max depth of pending paths. This should
    // really be pretty small, like 250, so we don't consume a bunch
    // of memory. However, for now, lets let it float pretty high
    // so it doesn't hang... We need a longer term solution for this
    // as, even with the higher value, it can still hang, but it is
    // unlikely
    if (auto ccode =
            m_queue.start(_location, "scanner", m_threadCount, MaxValue<size_t>,
                          _bind(&Scanner::scanProcess, this))) {
        // Log a message
        MONERR(error, ccode, "Failed to start scan queue");
        return ccode;
    }

    // Scan the endpoint
    if (auto ccode = scanService())
        MONERR(error, ccode, "Failed to scan the service");

    // Now we're done submitting things, flush to complete them all
    LOGT("Stopping queues");

    // Stop the queue at this point, we will restart for the next
    // service
    m_queue.stop();

    // If the scan didn't report any error, see if we got a fatal
    // error somewhere along the way
    if (!ccode) ccode = m_fatalError;

    if (!m_accumCounts.count) {
        MONERR(warning, Ec::Warning,
               "Files not found — path(s) may be invalid or empty");
    }

    return ccode;
}
}  // namespace engine::store::scan
