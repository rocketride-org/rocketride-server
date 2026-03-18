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

namespace engine::task::scan::catalog {
//-------------------------------------------------------------------------
/// @details
///     Return url where we are writing the output pipe to
//-------------------------------------------------------------------------
Url Task::ScanCatalog::segmentPath() noexcept {
    // Get the output path to write to
    return m_outputUrl.expandRequired(
        "BatchId", _tso(Format::HEX | Format::FILL, m_nextSegmentId));
}

//-------------------------------------------------------------------------
/// @details
///     Given an object entry, this function will back it
///	@param [in]		object
///		Object to pack
///	@param [out]	line
///		Receives the line
//-------------------------------------------------------------------------
Error Task::ScanCatalog::packObject(const Entry &object, Text &line) noexcept {
    if (!(scanProtocolCaps & Url::PROTOCOL_CAPS::SYNC)) {
        ASSERTD(object.isObject());
    }

    // Build the result
    json::Value result = _mv(_tj(object));

    auto operation = Entry::OPERATION::ADD;

    // Operation character mark to be provided by the endpoint in the sync mode
    if (scanProtocolCaps & Url::PROTOCOL_CAPS::SYNC) {
        if (!object.operation)
            return APERRT(Ec::InvalidState,
                          "Entry operation not set for Sync mode");

        operation = object.operation.get();
    }

    // Build the response
    line.clear();
    _tsbo(line, defFormatOptions(), operation, result.stringify(false), '\n');
    return {};
}

//-------------------------------------------------------------------------
/// @details
///     This function will flush the batch to the output file. If we don't
///		have an output file, then we must not have written anything to
///		it, so just return now. This is called when the overall scan task
///     is completed on the service
//-------------------------------------------------------------------------
Error Task::ScanCatalog::flushTask() noexcept {
    // If we do not have a stream open, then done
    if (!m_batchStream) return {};

    // Its possible to not have anything written to this segment, in that
    // case just delete it
    if (!m_batchCount.count) {
        LOGT("Nothing stored in segment {}, removing", m_batchStream);
        m_batchStream.reset();
        return {};
    }

    LOGT("Finalizing segment {} batch size {}, count {}", m_batchStream,
         m_batchCount.size, m_batchCount.count);

    // Finalize the segment
    if (auto ccode = m_batchStream->tryClose()) {
        m_fatalError = ccode;
        return ccode;
    }

    // Notify the monitor
    MONITOR(
        infoFmt,
        R"({"count": {}, "size": {}, "segmentName": "{}", "serviceKey": "{}"})",
        m_batchCount.count.asNumber(), m_batchCount.size.asBytes(),
        m_batchStream->path().fileName(), scanServiceKey);

    // Reset this batches count and size
    m_batchCount.count = 0;
    m_batchCount.size = 0;

    // Reset the stream
    m_batchStream.reset();
    return {};
}

//-------------------------------------------------------------------------
/// @details
///     This function will flush the batch to the output file. We have
///     the mutex here so, use it judicously. This is called when a
///     context, or scan thread, is done
/// @param[in]  context
///     Context we are flushing
//-------------------------------------------------------------------------
Error Task::ScanCatalog::flushContext(ScanContext &context) noexcept {
    Error ccode;

    // If we do not have a stream open yet, open it
    if (!m_batchStream) {
        // Advance the segment id
        m_nextSegmentId++;

        // Open the stream, format the stream name to be the next segment id non
        // prefixed hex mode for easy sorting
        if (!(m_batchStream =
                  stream::openStream(segmentPath(), file::Mode::WRITE))) {
            m_fatalError = m_batchStream.ccode();
            return m_batchStream.ccode();
        }

        LOGT("Started new segment", m_batchStream);

        // Set the default
        PipeTaskHeader hdr = {.schema = PipeTaskSchema::JSONPIPE,
                              .type = m_outputType};

        // Write the header describing the schema
        if ((ccode = m_batchStream->tryWrite(_ts(hdr, '\n')))) {
            m_fatalError = ccode;
            return ccode;
        }
    }

    // If there is something to flush, add it to the stream
    if (context.bufferOffset) {
        LOGT("Flushing context with {} objects", context.objectCount);

        LOGT("Writing context objects");

        // Create a view of the buffer
        const auto buffer = InputData{_reCast<const uint8_t *>(context.buffer),
                                      context.bufferOffset};

        // Write to the stream
        if ((ccode = m_batchStream.value()->tryWrite(buffer))) {
            m_fatalError = m_batchStream.ccode();
            return ccode;
        }

        // Add the number of objects in this buffer to the current batches
        // count so we know when to submit it
        m_batchCount += context.objectCount;
    }

    // If it is time to flush this batch
    // Zero count value means max objects in one batch)
    if (m_maxCounts.count && m_maxCounts <= m_batchCount) {
        LOGT("Flushing batch", m_batchCount);

        // Flush it so the batch doesn't get too big
        if (auto ccode = flushTask()) return ccode;

    } else {
        LOGT("Defering batch flush, only {} objects", m_batchCount);
    }

    // Reset our context
    context.bufferOffset = 0;

    // And reset the context counts
    context.objectCount.reset();

    return {};
}

//-------------------------------------------------------------------------
/// @details
///     This function is called when an endpoint scanner has found
///		something that needs to added to the output file
///     Context we are flushing
///	@param[in]	line
///		The line to add to the batch output file
//-------------------------------------------------------------------------
Error Task::ScanCatalog::addBatch(ScanContext &context, Text &line) noexcept {
    Error ccode;

    // Get the length of this line
    const auto lineLength = line.size();

    // Create a local countSize, do not update m_batchCount yet
    CountSize countSize = m_batchCount;
    countSize += context.objectCount;

    // If the line would overflow or countSize (objectCount/objectSize) is
    // reached, flush the context Zero count value means max objects in one
    // batch)
    if ((m_maxCounts.count && m_maxCounts <= countSize) ||
        (lineLength + context.bufferOffset >= sizeof(context.buffer))) {
        // Log it
        LOGT("Adding batch flushing buffer");

        _block() {
            auto guard = m_lock.acquire();
            // Flush the context
            if ((ccode = flushContext(context))) return ccode;
        }

        // Starting a new context, so add the path again
        if ((ccode = writeBatchPath(context))) return ccode;
    }

    // Copy the text from the line to the output buffer - we
    // already checked the size
    memcpy(&context.buffer[context.bufferOffset], line.data(), lineLength);

    // Adjust the line length
    context.bufferOffset += lineLength;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///     This function add the +container entry to the context. This happens
///		on the first results coming in, or when after the context is
///		flushed
/// @param[in]  context
///     Context we are flushing
//-------------------------------------------------------------------------
Error Task::ScanCatalog::writeBatchPath(ScanContext &context) noexcept {
    // Get the url to write
    Url url;

    static const Path emptyPath;
    const Path &currentPath =
        (scanProtocolCaps & Url::PROTOCOL_CAPS::SYNC)
            ? emptyPath  // write empty url (protocol://Prefix) for sync
                         // endpoint
            : context.currentPath;

    if (auto ccode = Url::toUrl(scanProtocol, currentPath, url)) return ccode;

    // Use default format flags but not the delimiter
    context.containerLine.clear();
    _tsbo(context.containerLine, DefFormatFlags, "+", url, '\n');

    // Add the line to the batch
    return addBatch(context, context.containerLine);
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
Error Task::ScanCatalog::addScanObject(ScanContext &context, Entry &object,
                                       const Path &objectPath) noexcept {
    // If we need to output the +line since we got one done,
    // do so now
    if (context.outputContainer) {
        // Add the line to the batch, flush if needed
        if (auto ccode = writeBatchPath(context)) return ccode;

        // Don't do this again until we either flush,
        // or we have a new container
        context.outputContainer = false;
    }

    LOGTO(ScanObjects, "Adding", object.isObject() ? "object" : "container",
          objectPath);

    // Adjust the size
    context.objectCount += {1, object.isObject() ? object.size() : 0};

    // Add this batch to the total
    MONITOR(addCompleted, 1, object.isObject() ? object.size() : 0);

    // Take the object info and create the line from it
    packObject(object, context.objectLine);

    // Add the line to the batch, flush if needed
    if (auto ccode = addBatch(context, context.objectLine)) return ccode;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Execute the scan job
//-------------------------------------------------------------------------
Error Task::exec() noexcept {
    ErrorOr<ServiceEndpoint> result;

    // Only one key
    auto serviceConfig = taskConfig().lookup("service");

    // Create an endpoint
    m_sourceEndpoint =
        IServiceEndpoint::getSourceEndpoint({.jobConfig = jobConfig(),
                                             .taskConfig = taskConfig(),
                                             .serviceConfig = serviceConfig,
                                             .openMode = OPEN_MODE::SOURCE});

    if (!m_sourceEndpoint) return m_sourceEndpoint.ccode();

    // Save the output url and type into the ScanCatalog abstraction
    m_scanner.m_outputUrl = m_outputUrl;
    m_scanner.m_outputType = Type;

    // Lookup our batch values
    if (auto ccode = taskConfig().lookupAssign("maxObjectCount",
                                               m_scanner.m_maxCounts.count) ||
                     taskConfig().lookupAssign("maxObjectSize",
                                               m_scanner.m_maxCounts.size))
        return ccode;

    LOGTT(Perf, "Thread count", Count(m_threadCount));

    // Start the queues (note NO queue depth limit, to allow for recursion)
    auto start = time::now();

    // Scan it
    return m_scanner.scan(*m_sourceEndpoint);
}
}  // namespace engine::task::scan::catalog
