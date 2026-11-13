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

#pragma once

namespace ap::application {

/**
 * @brief Reads a full line (ending in '\n') from standard input (stdin).
 *
 * This function blocks until one full line is available from stdin.
 * If multiple lines are received in one ReadFile call, they are buffered
 * and returned one at a time in subsequent calls.
 *
 * Returns an empty string if stdin is closed (EOF or broken pipe).
 *
 * @return ErrorOr<Text> A line (with trailing newline), or error/empty string
 * on EOF.
 */
inline ErrorOr<Text> readLine() noexcept {
    static std::string readBuffer;
    static std::deque<std::string> pendingLines;

    HANDLE hStdin = ::GetStdHandle(STD_INPUT_HANDLE);
    if (hStdin == INVALID_HANDLE_VALUE) {
        return APERR(::GetLastError(), "GetStdHandle(STD_INPUT_HANDLE) failed");
    }

    // Return buffered line if one exists
    if (!pendingLines.empty()) {
        std::string line = std::move(pendingLines.front());
        pendingLines.pop_front();
        return Text{line};
    }

    constexpr DWORD CHUNK_SIZE = 256;
    char buffer[CHUNK_SIZE];
    DWORD bytesRead = 0;

    while (true) {
        // Blocking read from stdin
        BOOL success =
            ::ReadFile(hStdin, buffer, CHUNK_SIZE, &bytesRead, nullptr);

        if (!success) {
            DWORD error = ::GetLastError();

            if (error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF) {
                // stdin closed (EOF)
                if (!readBuffer.empty()) {
                    std::string lastLine = std::move(readBuffer);
                    readBuffer.clear();
                    return Text{lastLine};
                }
                return Text{""};
            }

            return APERR(error, "ReadFile(stdin) failed");
        }

        if (bytesRead == 0) {
            // EOF with no more data
            if (!readBuffer.empty()) {
                std::string lastLine = std::move(readBuffer);
                readBuffer.clear();
                return Text{lastLine};
            }
            return Text{""};
        }

        // Append newly read data
        readBuffer.append(buffer, bytesRead);

        // Extract complete lines
        size_t newlinePos;
        while ((newlinePos = readBuffer.find('\n')) != std::string::npos) {
            std::string line = readBuffer.substr(0, newlinePos + 1);
            pendingLines.emplace_back(std::move(line));
            readBuffer.erase(0, newlinePos + 1);
        }

        // If a complete line was found, return it
        if (!pendingLines.empty()) {
            std::string line = std::move(pendingLines.front());
            pendingLines.pop_front();
            return Text{line};
        }

        // Otherwise, continue reading until a full line arrives
    }
}

//-----------------------------------------------------------------------------
/// @brief Windows implementation of stdin monitoring (readMonitor)
///
/// @details
/// Blocks until stdin closes, then returns.
/// Uses PeekNamedPipe() to poll stdin without consuming data.
/// Detects ERROR_BROKEN_PIPE when parent process dies.
/// Polls every 1 second.
//-----------------------------------------------------------------------------
inline void readMonitor() noexcept {
    HANDLE hStdin = ::GetStdHandle(STD_INPUT_HANDLE);

    // Loop until stdin closes or monitor is stopped
    while (isStdinMonitorRunning()) {
        DWORD available = 0;

        // PeekNamedPipe doesn't consume data, just checks status
        if (!::PeekNamedPipe(hStdin, nullptr, 0, nullptr, &available,
                             nullptr)) {
            DWORD error = ::GetLastError();

            // Check for closure conditions
            if (error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF ||
                error == ERROR_INVALID_HANDLE) {
                // stdin closed - return to caller
                return;
            }
        }

        // Poll every 1 second
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
}

}  // namespace ap::application
