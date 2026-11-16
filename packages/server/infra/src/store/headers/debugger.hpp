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

namespace engine::store {
namespace py = pybind11;

class IServiceFilterInstance;

struct Breakpoint {
    bool enabled = true;
    std::string from_id;
    std::string to_id;
    std::string lane;

    Breakpoint() = default;

    Breakpoint(bool enabled_, std::string from, std::string to,
               std::string lane_)
        : enabled(enabled_),
          from_id(std::move(from)),
          to_id(std::move(to)),
          lane(std::move(lane_)) {}

    // Equality operator compares only from_id, to_id, and lane (not enabled)
    bool operator==(const Breakpoint &other) const {
        return from_id == other.from_id && to_id == other.to_id &&
               lane == other.lane;
    }
};

/**
 * @class DebuggerPause
 * @brief Provides a thread-safe mechanism to pause and resume execution across
 * multiple threads.
 *
 * This utility is designed to allow external control of a group of threads that
 * periodically call `checkPause()`. When paused, all threads will block in
 * `checkPause()` until `resumeAll()` is called.
 */
class DebuggerPause {
public:
    /**
     * @brief Check if execution is currently paused, and block if so.
     *
     * Threads should call this method periodically. If the debugger is paused,
     * the thread will block until `resumeAll()` is called. Otherwise, it
     * returns immediately.
     *
     * This method avoids unnecessary locking unless the paused flag is set,
     * making it efficient for use in performance-sensitive code.
     */
    void checkPause() {
        // Fast path: avoid locking if not paused
        if (!paused.load(std::memory_order_acquire)) return;

        // Slow path: paused is true, acquire lock and wait until resumed
        std::unique_lock<std::mutex> lock(mtx);
        cv.wait(lock, [this] { return !paused.load(); });
    }

    /**
     * @brief Pause all threads that call `checkPause()`.
     *
     * Sets the internal paused flag. Any thread entering `checkPause()` will
     * block until resumed. Threads already inside the wait will remain blocked.
     */
    void pauseAll() {
        std::lock_guard<std::mutex> lock(mtx);
        paused.store(true, std::memory_order_release);
    }

    /**
     * @brief Resume all paused threads.
     *
     * Clears the paused flag and notifies all waiting threads to resume
     * execution.
     */
    void resumeAll() {
        std::lock_guard<std::mutex> lock(mtx);
        paused.store(false, std::memory_order_release);
        cv.notify_all();
    }

    /**
     * @brief Check if the system is currently paused.
     *
     * @return true if paused, false otherwise.
     */
    bool isPaused() const { return paused.load(std::memory_order_acquire); }

private:
    std::mutex mtx;  ///< Mutex for guarding pause/resume state
    std::condition_variable
        cv;  ///< Condition variable for wait/notify mechanism
    std::atomic<bool> paused{
        false};  ///< Flag indicating whether execution is paused
};

/**
 * @class Debugger
 * @brief Provides debugging and task control functionality for monitoring the
 * execution of service instances and managing breakpoints.
 *
 * This class is intended to be used by the Python bindings and internal engine
 * code to track task execution, emit debugging information, and control
 * execution flow through breakpoint and step commands.
 */
class Debugger {
public:
    //---------------------------------------------------------------------
    // Execution tracing hooks (called from the engine binder)
    //---------------------------------------------------------------------

    /**
     * @brief Called when a service instance is entered.
     *
     * Increments internal recursion tracking and logs entry.
     * If trace is non-null, appends it to the monitor message.
     *
     * @param pInstance Pointer to the service instance being entered.
     * @param trace Optional JSON trace data to append to the monitor message.
     */
    void debugEnter(IServiceFilterInstance *pInstance,
                    const json::Value &trace = {}) noexcept;

    /**
     * @brief Called when a service instance is exited.
     *
     * Decrements internal recursion tracking and logs exit.
     * If trace is non-null, appends it to the monitor message.
     *
     * @param pInstance Pointer to the service instance being exited.
     * @param trace Optional JSON trace data to append to the monitor message.
     */
    void debugLeave(IServiceFilterInstance *pInstance,
                    const json::Value &trace = {}) noexcept;

    /**
     * @brief Called when a logical "break" is triggered between two service
     * instances.
     *
     * Typically used to pause execution and inspect context.
     *
     * @param pFrom Source service instance.
     * @param pTo Target service instance.
     * @param methodName Name of the method being executed during the break.
     */
    void debugBreak(IServiceFilterInstance *pFrom, IServiceFilterInstance *pTo,
                    const std::string &methodName) noexcept;

    /**
     * @brief Called when an error is encountered in a service-to-service call.
     *
     * Logs the error and may optionally trigger a break or recovery.
     *
     * @param pFrom Source service instance.
     * @param pTo Target service instance.
     * @param methodName Name of the method where the error occurred.
     * @param ccode Error object containing the failure code or message.
     */
    void debugError(IServiceFilterInstance *pFrom, IServiceFilterInstance *pTo,
                    const std::string &methodName, Error &ccode) noexcept;

    //---------------------------------------------------------------------
    // Task-level debugger commands (typically called from Python)
    //---------------------------------------------------------------------

    // Get the task id of the associated debugger endpoint
    std::string getTaskId() const noexcept;

    /// Stop task execution immediately.
    void taskStop() noexcept;

    /// Trigger a debug break (pause execution).
    void taskBreak() noexcept;

    /// Resume execution from a break state.
    void taskResume() noexcept;

    /// Check if the task is currently paused.
    bool taskIsPaused() const noexcept;

    /// Perform a step into (advance execution into the next method call).
    void taskStep() noexcept;

    /// Perform a step over (advance execution past the current method call).
    void taskStepOver() noexcept;

    /// Alias for taskStep() — useful for explicit naming in UI or scripting.
    void taskStepIn() noexcept;

    // Replace the current set of breakpoints with the given vector
    void taskBreakpointSet(const std::vector<Breakpoint> &breakpoints) noexcept;

    // Add a new breakpoint if it doesn't already exist
    void taskBreakpointAdd(const std::string &from_id, std::string to_id,
                           std::string lane) noexcept;

    // Remove a breakpoint matching the given identifiers
    void taskBreakpointRemove(const std::string &from_id, std::string to_id,
                              std::string lane) noexcept;

    // Enable a specific breakpoint
    void taskBreakpointEnable(const std::string &from_id, std::string to_id,
                              std::string lane) noexcept;

    // Disable a specific breakpoint
    void taskBreakpointDisable(const std::string &from_id, std::string to_id,
                               std::string lane) noexcept;

    // Return a copy of the current breakpoint list
    std::vector<Breakpoint> taskBreakpointList() noexcept;

private:
    //---------------------------------------------------------------------
    // Internal State
    //---------------------------------------------------------------------

    // Output a breakpoint to the log
    void _outputBreakpoint(const std::string &msg,
                           const Breakpoint &bp) noexcept;

    /// Tracks the recursion level of nested debugEnter/debugLeave calls.
    int m_recurseLevel = 0;

    /// Collection of encoded breakpoint identifiers (e.g., ("A", "B", "text")
    std::mutex m_breakpoint_lock;  ///< Mutex for guarding breakpoint list
    std::vector<Breakpoint>
        m_breakpoints;  ///< List of currently set breakpoints

    /// Weak reference to our underlying endpoint
    ServiceEndpointWeak m_endpoint;

    /// Break management for debugging
    DebuggerPause m_break;

    /// Controls the pause/resume state of the debugger.
    std::mutex m_pause_lock;  ///< Mutex for guarding pause/resume state
    std::condition_variable
        m_pause_event;  ///< Condition variable for wait/notify mechanism
    std::atomic<bool> m_paused{
        false};  ///< Flag indicating whether execution is paused

public:
    //---------------------------------------------------------------------
    // Static debugger management
    //---------------------------------------------------------------------
    static void registerDebugger(ServiceEndpointWeak endpoint);
    static void deregisterDebugger(const std::string &taskId);
    static Debugger *getDebugger(const std::string &taskId);
    static std::vector<std::string> listDebuggers();

private:
    static std::mutex s_registryMutex;
    static std::unordered_map<std::string, ServiceEndpointWeak>
        s_debuggerRegistry;
};
}  // namespace engine::store
