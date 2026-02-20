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

#include <functional>
#include <atomic>
#include <thread>

namespace ap::application {

//-----------------------------------------------------------------------------
/// @brief Callback function type for stdin closure events
///
/// @details
/// This callback will be invoked exactly once when stdin closure is detected.
/// It should handle cleanup and/or process termination as needed.
///
/// @example
/// @code
/// ap::application::setStdinCloseCallback([]() {
///     LOG(Always, "Parent died - shutting down");
///     std::exit(0);
/// });
/// ap::application::startStdinMonitor();
/// @endcode
//-----------------------------------------------------------------------------
using StdinCloseCallback = std::function<void()>;

//-----------------------------------------------------------------------------
/// @brief Register a callback to be invoked when stdin closes
///
/// @param callback Function to call when stdin closure is detected
///
/// @details
/// Triggers when:
/// - Parent process dies (pipe broken)
/// - stdin is explicitly closed
/// - stdin pipe hangup (POLLHUP on Unix, ERROR_BROKEN_PIPE on Windows)
///
/// The callback is guaranteed to be called at most once.
/// Thread-safe: Can be called from any thread.
//-----------------------------------------------------------------------------
void setStdinCloseCallback(StdinCloseCallback callback) noexcept;

//-----------------------------------------------------------------------------
/// @brief Start background thread monitoring stdin for closure
///
/// @details
/// Starts a background thread that polls stdin every 1 second.
/// Detects when parent process dies or stdin pipe closes.
/// Does NOT consume any data from stdin.
///
/// **Detection:**
/// - Unix: Uses poll() to detect POLLHUP, POLLERR, POLLNVAL
/// - Windows: Uses PeekNamedPipe() to detect ERROR_BROKEN_PIPE
///
/// Thread-safe: Can be called multiple times (subsequent calls are no-ops)
///
/// @note Must call setStdinCloseCallback() first to register handler
//-----------------------------------------------------------------------------
void startStdinMonitor() noexcept;

//-----------------------------------------------------------------------------
/// @brief Stop background monitoring thread
///
/// @details
/// Clears the callback (to prevent quickExit during shutdown), then signals
/// the background thread to stop and blocks until it terminates.
/// Automatically called during engine shutdown.
//-----------------------------------------------------------------------------
void stopStdinMonitor() noexcept;

//-----------------------------------------------------------------------------
/// @brief Check if stdin monitor is currently running
///
/// @return true if monitor thread is active, false otherwise
//-----------------------------------------------------------------------------
bool isStdinMonitorRunning() noexcept;

//-----------------------------------------------------------------------------
/// @brief Trigger the registered stdin closure callback (internal use)
///
/// @details
/// Called internally by the monitoring thread when closure is detected.
/// Ensures callback is invoked exactly once using atomic operations.
//-----------------------------------------------------------------------------
void triggerStdinClosed() noexcept;

//-----------------------------------------------------------------------------
/// @brief Platform-specific blocking monitor for stdin closure
///
/// @details
/// This function blocks until stdin closes, then returns.
/// Does NOT consume any data from stdin.
///
/// **Platform implementations:**
/// - Unix: Uses poll() to detect POLLHUP, POLLERR, POLLNVAL (1 second polling)
/// - Windows: Uses PeekNamedPipe() to detect ERROR_BROKEN_PIPE (1 second
/// polling)
///
/// Called by the common monitoring thread in stdinMonitor.cpp.
///
/// @note Platform-specific implementation in win/readLine.hpp or
/// unx/readLine.hpp
//-----------------------------------------------------------------------------
void readMonitor() noexcept;

}  // namespace ap::application
