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

#pragma once

#include <poll.h>

namespace ap::application {

/**
 * @brief Reads a full line from standard input (stdin).
 *
 * This function blocks until a line ending with '\n' is read from stdin.
 * If multiple lines are received in a single read, they are buffered and
 * returned one at a time on subsequent calls.
 *
 * If stdin is closed (EOF), the function returns any remaining buffered data,
 * or an empty string if there is none.
 *
 * @return ErrorOr<Text> A line from stdin (including the trailing '\n'),
 *         or an error if the read fails.
 */
inline ErrorOr<Text> readLine() noexcept {
    // Static buffer and queue to persist across calls
    static std::string readBuffer;
    static std::deque<std::string> pendingLines;

    const int io = fileno(stdin);  // Get file descriptor for stdin

    // If we already have a complete line buffered, return it immediately
    if (!pendingLines.empty()) {
        std::string line = std::move(pendingLines.front());
        pendingLines.pop_front();
        return Text{line};
    }

    std::array<char, 256> buf{};  // Temporary read buffer

    while (true) {
        // Blocking read from stdin
        ssize_t numRead = ::read(io, buf.data(), buf.size());

        if (numRead == -1) {
            // Error during read
            if (errno == EINTR) {
                // Interrupted by signal — retry
                continue;
            }
            return APERR(errno, "Failed reading from stdin");
        }

        if (numRead == 0) {
            // stdin was closed (EOF)
            if (!readBuffer.empty()) {
                // Return any remaining buffered data
                std::string line = std::move(readBuffer);
                readBuffer.clear();
                return Text{line};
            }
            // No more data; signal EOF
            return Text{""};
        }

        // Append newly read data to the persistent buffer
        readBuffer.append(buf.data(), numRead);

        // Extract and queue all complete lines
        size_t newlinePos;
        while ((newlinePos = readBuffer.find('\n')) != std::string::npos) {
            std::string line = readBuffer.substr(0, newlinePos + 1);
            pendingLines.emplace_back(std::move(line));
            readBuffer.erase(0, newlinePos + 1);
        }

        // If at least one complete line was read, return it
        if (!pendingLines.empty()) {
            std::string line = std::move(pendingLines.front());
            pendingLines.pop_front();
            return Text{line};
        }

        // Otherwise, continue reading more bytes
    }
}

//-----------------------------------------------------------------------------
/// @brief Unix/Linux implementation of stdin monitoring (readMonitor)
///
/// @details
/// Blocks until stdin closes, then returns.
/// Uses poll() to detect POLLHUP when parent process dies.
/// Polls every 1 second.
/// Does not consume data from stdin.
//-----------------------------------------------------------------------------
inline void readMonitor() noexcept {
    const int io = fileno(stdin);

    // Loop until stdin closes or monitor is stopped
    while (isStdinMonitorRunning()) {
        struct pollfd fds;
        fds.fd = io;
        fds.events = POLLIN;

        // Poll with 1 second timeout
        int ret = poll(&fds, 1, 1000);

        if (ret > 0) {
            // Check for closure conditions:
            // POLLHUP:  Pipe's write end closed (parent died)
            // POLLERR:  Error condition on stdin
            // POLLNVAL: File descriptor is not open
            if (fds.revents & (POLLHUP | POLLERR | POLLNVAL)) {
                // stdin closed - return to caller
                return;
            }
        }
        // ret == 0: timeout, continue
        // ret < 0: error (EINTR is normal), continue
    }
}

}  // namespace ap::application
