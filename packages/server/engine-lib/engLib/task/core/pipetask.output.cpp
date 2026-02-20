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

namespace engine::task {
//-------------------------------------------------------------------------
/// @details
///		Open the output if we have one
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::openOutput() noexcept {
    // If we already opened it done
    if (m_output) return {};

    // Null op if no output defined
    if (!m_outputUrl) return {};

    // Get a lock on output - make sure we do this orderly
    auto guard = m_outputLock.acquire();

    // If we have an output pipe, open it now. It is actually optional
    // depending on the task type
    if (!(m_output =
              stream::openBufferedStream(m_outputUrl, file::Mode::WRITE)))
        return APERRT(m_output.ccode(), "Failed to open output service",
                      m_outputUrl);

    LOGTT(Perf, "Opened output", m_output);

    // Get the header
    PipeTaskHeader hdr;
    if (auto ccode = buildHeader(hdr)) return ccode;

    // Convert to a string
    auto hdrLine = _tj(hdr).stringify(false);

    // And write it
    LOGT("Writing header", hdrLine);
    return m_output->tryWrite(hdrLine.append("\n"));
}

//-------------------------------------------------------------------------
/// @details
///		Wrap an error with the target path
///	@param[in] path
///		The path which caused the error
///	@param[in] error
///		The error information
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::wrapError(const Entry& entry,
                                 const Error& error) noexcept {
    // Wrap the error so we can guarantee the path is included. If we have it,
    // keep the original error location
    Text wrappedErrorMessage = error.message();

    // Append the url
    wrappedErrorMessage += _ts(" [", entry.url(), "]");

    // Wrap it
    auto wrappedError =
        Error(error.code(), error.location(), _mv(wrappedErrorMessage));

    // And return it
    return wrappedError;
}

//-------------------------------------------------------------------------
/// @details
///		Close the output
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::closeOutput() noexcept {
    LOGTT(Perf, "Finalizing output {}", m_output);

    // If we have an output open
    if (m_output) {
        // Get a lock on output - make sure we do this orderly
        auto guard = m_outputLock.acquire();

        // We have to check this again, since we checked it
        // outside the guard
        if (!m_output) return {};

        // Attempt to close it
        auto ccode = m_output->tryClose();

        // Clear the stream ptr
        m_output.reset();

        // And return
        return ccode;
    }

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Output a line(s) to the output file
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::writeText(const Text& text) noexcept {
    // If we do not have an output channel, ignore this
    if (!m_output) return {};

    // Get a lock on output - make sure we do this orderly
    auto guard = m_outputLock.acquire();

    // We have to check this again, since we checked it outside the guard
    if (!m_output) return {};

    // Attempt the output
    auto ccode = m_output->tryWrite(text);
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Log a warning to the log and monitor. Note that this will not
///		cause a response line, just log it
///	@param[in]	url
///		The affected url
///	@param[in]	ccode
///		The warning to log
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::writeWarning(const Entry& entry,
                                    const Error& ccode) noexcept {
    // Get the wrapped error
    auto wrapped = wrapError(entry, ccode);

    // Log it
    LOGT(wrapped);

    // And output to the monitor
    MONERR(warning, wrapped, wrapped.message());

    // Done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Write an error line with entry information to the output
///	@param[in] entry
///		The entry info
///	@param[in] error
///		The error information
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::writeError(const Entry& entry,
                                  const Error& error) noexcept {
    // Create a line on the stack
    StackTextArena arena;
    StackText line{arena};

    // Add the path to the error code
    auto wrappedError = wrapError(entry, error);

    // Report the error to the monitor and log it
    LOGT(wrappedError);
    if (auto& monitor = config::monitor()) monitor->warning(_mv(wrappedError));

    // Fill in the error
    json::Value errorInfo;
    errorInfo["path"] = (TextView)entry.url().fullpath();
    errorInfo["error"] = _tj(error);
    if (entry.objectId) errorInfo["objectId"] = entry.objectId();
    if (entry.instanceId) errorInfo["instanceId"] = entry.instanceId();
    if (entry.flags) errorInfo["flags"] = entry.flags();
    if (entry.iflags) errorInfo["iFlags"] = entry.iflags();

    // E*{instanceId=0|objectId="", error=""}
    line.clear();
    _tsbo(line, defFormatOptions(), 'E', errorInfo.stringify(false), '\n');

    // Write the line
    return writeText(line);
}

//-------------------------------------------------------------------------
/// @details
///		Output a line(s) to the output file
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::writeResult(const Text& text) noexcept {
    // Write the line
    return writeText(text);
}

//-------------------------------------------------------------------------
/// @details
///		Output a line(s) to the output file
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::writeResult(const TextChr resultType,
                                   const json::Value& value) noexcept {
    // Create a line on the stack
    StackTextArena arena;
    StackText line{arena};

    // Unbelievably, _tsbo appends
    line.clear();

    // ?*{json}
    _tsbo(line, defFormatOptions(), resultType, value.stringify(false), '\n');

    // Write the line
    return writeText(line);
}

//-------------------------------------------------------------------------
/// @details
///		Output a line(s) to the output file
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::writeResult(const TextChr resultType,
                                   const Entry& entry) noexcept {
    // Build the result
    json::Value result = _mv(_tj(entry));

    // And write it
    return writeResult(resultType, result);
}
}  // namespace engine::task
