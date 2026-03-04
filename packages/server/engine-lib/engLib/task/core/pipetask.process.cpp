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

namespace engine::task {
static constexpr uint32_t MAX_RETRIES = 5u;

//-------------------------------------------------------------------------
/// @details
///		Determines if the given line is a directory ntry (+) line or not
///	@param[in]	line
///		Line to check
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
bool IPipeTask<LvlT>::isDirectoryEntry(TextView line) noexcept {
    // Directory entries start with '+' followed by a URL
    // (usually file://, but may use custom schemes)
    return line && line[0] == '+';
}

//-------------------------------------------------------------------------
/// @details
///		Determines if the given line is a comment (# or //) line or not
///	@param[in]	line
///		Line to check
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
bool IPipeTask<LvlT>::isComment(TextView line) noexcept {
    // Comments start with '#' or '//'
    return line.starts_with('#') || line.starts_with("//");
}

//-------------------------------------------------------------------------
/// @details
///		This is the thread to process an entry that has been placed on the
///		queue.
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::processThread() noexcept {
    // Output the log message
    LOGT("Starting process thread");

    // attempt to process items in bulk
    auto ccode = processItems();
    if (ccode != Ec::NotSupported) return ccode;

    // Processing loop
    while (true) {
        // Get the next item
        auto item = m_queue.pop();

        // If we got an error
        if (!item) {
            // If we completed the queue, we are done
            if (item.ccode() == Ec::Completed) break;

            // Some other queue error, save the error code. This will probably
            // hang things up since the queue is not completed, but we couldn't
            // empty it due to an error
            handleTerminalError(item.ccode());
            break;
        }

        // Start processing
        LOGT("Begin processing", *item);

        // Process the item - return an error if we have a fatal error
        // This must call write* to write its response
        if (auto ccode = processItem(*item)) {
            // We got a terminal error, process it
            handleTerminalError(ccode);
            break;
        }

        // Done processing
        LOGT("Processing complete", item);
    }

    // We are done. Either the queue is completed, or we have a
    // pending terminal error
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Attempt to process items in bulk. The default implementation
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::processItems() noexcept {
    // Output the log message
    LOGT("Attempting bulk processing");

    std::vector<Entry> items;
    size_t requestedSize = 0;
    bool popItems = true;

    // Now process items in bulk
    while (popItems || !items.empty()) {
        // Pop items from queue up to requestedSize
        while (items.size() < requestedSize) {
            // Get the next item
            auto item = m_queue.pop();

            // If we got an error
            if (!item) {
                // If we failed to pop the next item from the queue, check for
                // the "queue empty" error code. If it's anything other than
                // that, bail
                if (item.ccode() != Ec::Completed) {
                    // Send the error to the monitor and error out the task
                    handleTerminalError(item.ccode());
                    return m_terminalError;
                } else {
                    LOGT("No more items in queue for bulk processing");
                    popItems = false;  // No more items to process
                }

                // The queue is now done
                break;
            }

            // If we have a pending terminal error, don't process, consume the
            // entry so the queue is emptied. Once emptied, stop
            if (m_terminalError) {
                // Start processing
                LOGT("Terminal error pending, skip", *item);
                continue;
            }

            // Add item to vector
            auto entry = _mv(*item);
            entry.attempt = 0u;  // Reset attempt count for bulk processing
            items.push_back(_mv(entry));
        }

        if (!popItems && items.empty()) {
            LOGT("No more items to process, exiting bulk processing");
            break;  // No more items to process
        }

        // Start processing bulk
        auto itemsAtBegin = items.size();
        LOGT("Bulk processing: beginning processing of", itemsAtBegin, "items");

        // Process the items vector - return an error if we have a fatal error
        auto processingResult = processItems(items);
        // processing finished with error -> store error and continue
        if (processingResult.hasCcode()) {
            if (processingResult.ccode() == Ec::NotSupported) {
                LOGT("Bulk processing not supported, skipping");
                return processingResult.ccode();
            }
            handleTerminalError(processingResult.ccode());
            return m_terminalError;
        }

        // Done processing bulk
        auto itemsAtEnd = items.size();
        LOGT("Bulk processing: processed", itemsAtBegin, "items to", itemsAtEnd,
             "items");

        if (itemsAtBegin > 0 && itemsAtEnd == 0) {
            LOGT("Bulk processing: permissions were reset for all",
                 itemsAtBegin, "items");
            continue;
        }

        // Process each item in the vector and handle retries
        // Use reverse iteration to safely remove elements
        for (auto it = items.rbegin(); it != items.rend();) {
            // Check completion code
            if (it->completionCode() == Ec::Retry) {
                if (it->attempt < MAX_RETRIES) {
                    // Increment attempt count and keep for retry
                    ++it->attempt;
                    LOGT("Item marked for retry, attempt", it->attempt,
                         "; item:", *it);
                    it->completionCode.reset();
                    ++it;  // Move to next item
                } else {
                    MONITOR(addFailed, 1, it->size());
                    // Max retries exceeded, mark as failed
                    it->completionCode(
                        APERR(Ec::Failed, "Max retries exceeded"));
                    LOGT("Item failed after max retries", *it);

                    // write error
                    if (auto ccode = writeError(*it, it->completionCode()))
                        handleTerminalError(ccode);

                    // Remove failed item from vector
                    it = std::reverse_iterator(
                        items.erase(std::next(it).base()));
                }
            } else {
                // Item completed successfully or failed permanently, remove
                // from vector
                LOGT("Processing complete", *it);
                // Remove completed item from vector
                it = std::reverse_iterator(items.erase(std::next(it).base()));
            }
        }

        // Done processing bulk
        LOGT("Bulk processing:", items.size(), "items remain for retry");

        requestedSize = processingResult.value();
        if (requestedSize == 0) {
            return APERR(
                Ec::InvalidParam,
                "Requested size for bulk processing is zero, aborting");
        }
    }

    // If we got here we didn't error
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Process items in bulk. Default implementation returns NotSupported
///		to indicate bulk processing is not available. Override this method
///		to provide bulk processing functionality.
/// @param[inout] items
///     Vector of items to process
///	@returns
///		ErrorOr<size_t> - Error or requested size for next batch
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
ErrorOr<size_t> IPipeTask<LvlT>::processItems(
    std::vector<Entry>& items) noexcept {
    // Default implementation doesn't support bulk processing
    return APERRT(Ec::NotSupported, "Bulk processing not implemented");
}

//-------------------------------------------------------------------------
/// @details
///		Get the thread count for the job type
/// @param[in] currentThreadCount
///     Current thread count
///	@returns
///		uint32_t - Thread count
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
uint32_t IPipeTask<LvlT>::getThreadCount(
    uint32_t currentThreadCount) const noexcept {
    return currentThreadCount;
}

//-------------------------------------------------------------------------
/// @details
///		Start our threaded queue
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::startQueue() noexcept {
    // adjust thread count based on the job type
    auto threadCount = getThreadCount(m_threadCount);
    LOGT("Initial thread count", m_threadCount, "; calculated thread",
         threadCount);
    m_threadCount = threadCount;

    return m_queue.start(_location, Parent::type(), m_threadCount, m_queueDepth,
                         _bind(&IPipeTask::processThread, this));
}

//-------------------------------------------------------------------------
/// @details
///		Wait for the queues to finish up
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::waitForComplete() noexcept {
    // Now we're done submitting things, flush to complete them all
    LOGT("Flushing queues");

    // Flush the queue
    if (auto ccode = m_queue.flush()) {
        // Log a message
        MONERR(warning, ccode, "Unable to flush the queue", type());
        m_terminalError = ccode;
    }

    // Stop the queue
    m_queue.stop();
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Adds the item to the processing queue
/// @param[in] item
///     The item to add
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::queueItem(Entry& item) noexcept {
    // If we have a terminal error, don't queue anything
    if (m_terminalError) return m_terminalError;

    // Add the item to the queue
    return m_queue.push(_mv(item));
}

//-------------------------------------------------------------------------
/// @details
///		This function will process an incoming line. If it is not a
///     directory specifier (+line), then it will call the override to
///     process the line
/// @param[in] line
///     The line to process
/// @param[inout] parent
///     The current parent/receives the new parent if it is a directory
///     line
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::processInput(TextView line_, Url& parent) noexcept {
    Text line = line_;

    // Check if the overall job is cancelled
    if (auto ccode = async::cancelled(_location)) return ccode;

    // Log it
    LOG(Lines, "Processing request line", line);

    // Empty lines are unexpected
    if (!line)
        return APERRT(Ec::InvalidParam, "Blank line in pipe", m_outputUrl);

    // Now, we have the line, see if it starts with <lin> or <win>. This
    // used mainly for testing cross platforms
    if (line[0] == '<' && line[4] == '>') {
        // Yes, it is an os specifier
        if (line.substr(0, 5) == "<win>") {
            if (!ap::plat::IsWindows) return {};
        } else if (line.substr(0, 5) == "<lin>") {
            if (!ap::plat::IsLinux) return {};
        } else if (line.substr(0, 5) == "<mac>") {
            if (!ap::plat::IsMac) return {};
        } else if (line.substr(0, 5) == "<unx>") {
            if (!ap::plat::IsUnix) return {};
        } else
            return {};

        // Trim off the OS specifier
        line = line.substr(5);
    }

    // Ignore comments
    if (isComment(line)) return {};

    // If we are on debug mode, allow path substitution
    if (ap::plat::IsDebug) line = config::expand(line);

    // If this is a directory line
    if (isDirectoryEntry(line)) {
        parent = line.substr(1);
        LOGT("Current directory:", parent);
        return {};
    }

    // Send to the task
    auto res = processLine(line, parent);

    // If we did not get an entry back
    if (!res) {
        // If there was an error, output it
        if (res.ccode() != Ec::End)
            return MONERR(error, res, "Invalid request line", line);

        // Otherwise, no error, just nothing to add
        return {};
    }

    queueItem(*res);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This class is the base dispatcher for all PipeIO jobs
///		that are driven by a request file. Due to this being
///		the primary input method an attempt has been made to
///		be as efficient as possible when reading a series of lines
///		from a buffered streams which dispatches to a series of threads
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::enumInput() noexcept {
    // Open up the input stream
    auto _stream = stream::openBufferedStream(m_inputUrl, file::Mode::READ);
    if (!_stream) return _stream.ccode();

    // Use the buffer api directly to avoid copies
    auto stream = _polyPtrCast<stream::BufferedStream>(*_stream);
    if (!stream)
        return APERRT(Ec::InvalidParam, "Buffering required for job",
                      Parent::type());

    auto processedHeader = false;
    Url parent;
    StackText trailing;
    while (auto buff = stream->get()) {
        // Check if we are cancelled
        if (async::cancelled()) return async::cancelled(_location);

        TextView data{buff->cursor.data(), buff->cursor.size()};
        auto last = data.find_last_of('\n');
        ASSERT(last != string::npos);

        // Now efficiently walk these new lines logically and parse out a
        // line for processing
        size_t start = 0, pos = 0;
        while (pos < data.size()) {
            pos = data.find_first_of('\n', start);
            if (pos == string::npos) break;

            auto incGuard = util::Guard{[&]() noexcept { start = pos + 1; }};

            if (start == 0 && trailing) {
                trailing += data.substr(0, pos);
                if (auto ccode = processInput(trailing, parent)) return ccode;
                trailing.clear();
                continue;
            }
            if (pos == 0) continue;

            auto line = data.substr(start, pos - start);
            while (line.endsWith('\n') || line.endsWith('\r')) line--;

            LOG(Lines, "Processing line", line);

            // First line should be the header
            if (!_exch(processedHeader, true)) {
                // Parse the header
                auto hdr = json::parse<PipeTaskHeader>(line);
                if (!hdr)
                    return APERRT(Ec::InvalidFormat,
                                  "Failed to parse header line", line);

                // Process the header - check if it is good to go
                if (auto ccode = processHeader(*hdr)) return ccode;

                // Successfully processed the header, means we can
                // open the output now before we start kicking off
                // processing the lines
                if (auto ccode = openOutput()) return ccode;
                continue;
            }

            // Now process this line, send it out if needed
            if (auto ccode = processInput(line, parent)) return ccode;
        }

        // Save the trailing line to be pre-pended on the next read this
        // is when we don't exactly read on a new line boundary
        if (last != data.size() - 1) {
            ASSERT(last + 1 < data.size());
            trailing = data.substr(last + 1);
        }

        if (auto ccode = stream->put(_mv(*buff))) return ccode;
    }

    // Should have no stragglers
    if (trailing)
        return APERRT(Ec::InvalidFormat, "Trailing entry in request stream",
                      trailing);

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Gets the header to write to the output pipe
/// @param[out] hdr
///     Receives the output header to write
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::buildHeader(PipeTaskHeader& hdr) noexcept {
    // Set the default
    hdr = {.schema = PipeTaskSchema::JSONPIPE, .type = Parent::type()};
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Processes the header coming from the input file
/// @param[in] hdr
///     The header we found
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::processHeader(const PipeTaskHeader& hdr) noexcept {
    // Check if cancelled
    if (auto ccode = async::cancelled(_location)) return ccode;

    // We validated it
    LOGT("Validated header", hdr);

    ASSERT(!m_header);
    m_header = hdr;
    return {};
}

//-----------------------------------------------------------------
///	@details
///		Processes a json input line by creating an entry from
///		it. This function is the default function called when
///		the task does not override the processLine (without
///		the type) is not overriden
/// @param[in] opType
///     The expected operation type (or "" for no check)
/// @param[in] line
///		The incoming line - json format
/// @param[inout] currentParent
///		The current parent
//-----------------------------------------------------------------
template <log::Lvl LvlT>
ErrorOr<Entry> IPipeTask<LvlT>::processLine(TextView opType, TextView line,
                                            const Url& currentParent) noexcept {
    // Check to make sure we have a parent path
    if (!currentParent)
        return APERRT(Ec::InvalidState, "No current directory set");

    // Tokenize the line - json format
    // {action}*{entry json}
    auto [op, entryStr] = string::view::tokenizeArray<2>(line, '*');
    if (opType.size() && op.size() && op != opType)
        return APERRT(Ec::InvalidParam);

    // Now parse the json
    auto errorOrJson = json::parse(entryStr);
    if (!errorOrJson) return errorOrJson.ccode();

    // Get the actual json object
    auto entryJson = *errorOrJson;

    // Make the entry from it
    return Entry::makeEntry(currentParent, entryJson);
}

//-------------------------------------------------------------------------
/// @details
///		This function will process an incoming line. The purpose is
///		to take the line, convert it to an entry, etc.
///		For json formatted input files, just call the above processLine
///		with the line type. For non-json files, parse it and return
///		the Entry
/// @param[in] line
///     The line to process
/// @param[inout] currentParent
///     The current parent
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
ErrorOr<Entry> IPipeTask<LvlT>::processLine(TextView line,
                                            const Url& currentParent) noexcept {
    // Default to json, no verification of type - this should be overridden
    // to with the type passed
    return processLine(""_tv, line, currentParent);
}

//-------------------------------------------------------------------------
/// @details
///		This function will process an incoming item and a source pipe (so
///		it can be re-used). It may be overridden by the task controller
///		itself but this default implementation simply calls render on the
///		source to write to the target, which is what most tasks will do
/// @param[in] entry
///     The entry to process
///	@param[in] sourcePipe
///		The source pipe to use
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::processItem(Entry& entry,
                                   ServicePipe& sourcePipe) noexcept {
    Error ccode;

    // Start/stop the counters
    util::Guard entryScope{[&] { MONITOR(beginObject, entry); },
                           [&] { MONITOR(endObject, entry); }};

    // Define the lambda to catch any errors
    const auto process = [&]() -> Error {
        // Allocate/release the target pipe
        ErrorOr<ServicePipe> targetPipe;
        util::Guard targetPipeGuard{
            [&] { targetPipe = m_targetEndpoint->getPipe(); },
            [&] {
                if (targetPipe) m_targetEndpoint->putPipe(*targetPipe);
            }};

        // Check to make sure we got it
        if (!targetPipe) return targetPipe.ccode();

        // skip object if it is an container
        if (!entry.isObject()) return {};

        // prepare object if required
        if (ccode = sourcePipe->prepareObject(entry)) return ccode;

        // Open on the target
        if (ccode = targetPipe->open(entry)) return ccode;

        // If we suceeded open, then render to the target
        if (!entry.completionCode)
            ccode = sourcePipe->renderObject(*targetPipe, entry);

        // Close the target pipe - make sure it's closed. This won't
        // be passed on if it is already closed
        ccode = targetPipe->close() || ccode;

        // And done
        return ccode;
    };

    // If this object has already failed, don't process it further
    if (!entry.completionCode) {
        // Render it
        ccode = _callChk([&] { return process(); });
    }

    // If this entry did not fail, but we got an error, mark
    // the entry with the fatal error
    if (!entry.completionCode && ccode) entry.completionCode(ccode);

    // See how many consecutive failures we have
    _block() {
        // Acquire the mutex so we can manipulate the failure count
        auto guard = m_consecutiveLock.acquire();

        // If this one failed
        if (entry.completionCode && !entry.objectSkipped()) {
            // Add one more to the count
            m_consecutiveFailures++;

            // If it's too many, signal a fatal error
            if (m_consecutiveFailures >= m_maxConsecutiveFailures &&
                !(sourcePipe->endpoint->capabilities &
                  url::UrlConfig::PROTOCOL_CAPS::NOMONITOR)) {
                return APERRT(Ec::Cancelled, "Too many consecutive failures:",
                              m_consecutiveFailures);
            }
        } else {
            // We got one through, reset the count
            m_consecutiveFailures = 0;
        }
    }

    // We either don't have enough consecutive failures to stop the
    // task, or we succeeded with this item
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This function will process an incoming item. It may be overridden
///		by the task controller itself but this default implementation simply
///		calls render on the source to write to the target, which is what
///		most tasks will do
/// @param[in] entry
///     The entry to process
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::processItem(Entry& entry) noexcept {
    // Allocate/release the source pipe
    ErrorOr<ServicePipe> sourcePipe;
    util::Guard sourcePipeGuard{
        [&] { sourcePipe = m_sourceEndpoint->getPipe(); },
        [&] {
            if (sourcePipe) m_sourceEndpoint->putPipe(*sourcePipe);
        }};

    // Check to make sure we got it
    if (!sourcePipe) return sourcePipe.ccode();

    // Process the enty
    return processItem(entry, *sourcePipe);
}

//-------------------------------------------------------------------------
/// @details
///		Setup the processor by opening the output if we have one and
///		starting the service threads
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::beginTask() noexcept {
    // Setup the common configuration
    if (auto ccode = jobConfig().lookupAssign("taskId", m_taskId) ||
                     taskConfig().lookupAssign("maxConsecutiveFailures",
                                               m_maxConsecutiveFailures) ||
                     taskConfig().lookupAssign("threadCount", m_threadCount) ||
                     taskConfig().lookupAssign("queueDepth", m_queueDepth) ||
                     taskConfig().lookupAssign("output", m_outputUrl) ||
                     taskConfig().lookupAssign("input", m_inputUrl))
        return ccode;

    // Allow the target to directly write to our output file
    if (m_targetEndpoint) (*m_targetEndpoint)->bindTask(this);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Finalize and flush our queue, make sure we are done
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::exec() noexcept {
    // Start out queues
    if (auto ccode = startQueue()) {
        // Log a message and return the error
        MONERR(error, ccode, "Unable to start the queue");
        return ccode;
    }

    // Log some stats
    LOGTT(Perf, "Thread count", Count(m_threadCount));
    auto start = time::now();

    // Read the request file and populate the streams
    if (auto ccode = enumInput()) {
        // Log a message and save the error
        MONERR(error, ccode, "Unable to process input", type());
        m_terminalError = ccode;
    }

    if (auto ccode = waitForComplete()) {
        // Log a message
        MONERR(error, ccode, "Unable to wait for completion", type());
        m_terminalError = ccode;
    }

    LOGTT(Perf, "Job completed in {}", time::now() - start);

    // Return the terminal error if any
    return m_terminalError;
}

//-------------------------------------------------------------------------
/// @details
///		Setup the processor by opening the output if we have one and
///		starting the service threads
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::endTask() noexcept {
    Error ccode;

    // Close out the source endpoint if we have one
    if (m_sourceEndpoint) {
        if (auto endCode = m_sourceEndpoint->endEndpoint())
            ccode = APERRT(endCode, "Failed to end source endpoint");
        m_sourceEndpoint.reset();
    }

    // Close out the source endpoint if we have one
    if (m_targetEndpoint) {
        if (auto endCode = m_targetEndpoint->endEndpoint())
            ccode = APERRT(endCode, "Failed to end target endpoint");
        m_targetEndpoint.reset();
    }

    // And close the output
    if (auto endCode = closeOutput())
        ccode = APERRT(ccode, "Failed to close output stream");
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Handles terminal errors by saving the error, logging it, emptying
///		the queue, and signaling the endpoint
/// @param[in] ccode
///     The error code to handle
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
void IPipeTask<LvlT>::handleTerminalError(const Error& ccode) noexcept {
    // Save it
    m_terminalError = ccode;

    // Output it to the monitor
    MONCCODE(error, ccode);

    // Empty the queue
    while (true) {
        // Get the next item
        auto item = m_queue.tryPop();

        // If we got an error
        if (!item) break;

        // Mark this with the terminal error
        item->completionCode(ccode);

        // Process it - it should not actually process it
        // with the pending error, but it will log it
        processItem(*item);
    }

    // Build up the signal parameters - there are none
    json::Value param = json::Value();

    // Signal the endpoint we have a terminal error
    m_sourceEndpoint->signal("terminalError", param);
}
}  // namespace engine::task
