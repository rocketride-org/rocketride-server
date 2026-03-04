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

#include <apLib/ap.h>

namespace ap::application {

//-----------------------------------------------------------------------------
// Internal state - common to all platforms
//-----------------------------------------------------------------------------
namespace {
/// @brief User-registered callback to invoke on stdin closure
StdinCloseCallback g_closeCallback;

/// @brief Atomic flag to ensure callback is triggered exactly once
std::atomic<bool> g_callbackTriggered{false};

/// @brief Flag to control the background monitoring thread's execution
std::atomic<bool> g_monitorRunning{false};

/// @brief Background thread that monitors stdin
std::thread g_monitorThread;

/// @brief Guard to detach thread before its destructor runs
/// Static destruction order is reverse of construction, so this
/// destructor runs BEFORE g_monitorThread's destructor
struct MonitorGuard {
    ~MonitorGuard() {
        if (g_monitorThread.joinable()) {
            g_monitorThread.detach();
        }
    }
} g_monitorGuard;
}  // namespace

//-----------------------------------------------------------------------------
void setStdinCloseCallback(StdinCloseCallback callback) noexcept {
    g_closeCallback = std::move(callback);
    g_callbackTriggered = false;
}

//-----------------------------------------------------------------------------
void triggerStdinClosed() noexcept {
    // Atomically check and set the flag
    // If already triggered, bail out immediately
    if (g_callbackTriggered.exchange(true)) return;

    // Invoke the callback if one was registered
    if (g_closeCallback) {
        g_closeCallback();
    }
}

//-----------------------------------------------------------------------------
void startStdinMonitor() noexcept {
    // Atomically check if already running (prevents multiple threads)
    if (g_monitorRunning.exchange(true)) return;  // Already started

    // Launch background thread
    g_monitorThread = std::thread([]() {
        // Call platform-specific blocking function
        // This blocks until stdin closes, then returns
        readMonitor();

        // stdin closed - trigger callback
        triggerStdinClosed();
    });
}

//-----------------------------------------------------------------------------
void stopStdinMonitor() noexcept {
    // Clear callback first to prevent it firing during shutdown
    g_closeCallback = nullptr;
    g_callbackTriggered = true;

    // Signal the thread to stop
    g_monitorRunning = false;

    // Wait for thread to actually terminate
    if (g_monitorThread.joinable()) {
        g_monitorThread.join();
    }
}

//-----------------------------------------------------------------------------
bool isStdinMonitorRunning() noexcept { return g_monitorRunning; }

}  // namespace ap::application
