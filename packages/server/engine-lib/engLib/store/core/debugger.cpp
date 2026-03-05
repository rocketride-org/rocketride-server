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

// Static member definitions
std::mutex Debugger::s_registryMutex;
std::unordered_map<std::string, ServiceEndpointWeak>
    Debugger::s_debuggerRegistry;

/**
 * @class Debugger
 * @brief Provides debugging interface for tracking execution flow and
 * task-level controls.
 *
 * This class is intended to be called by the execution engine or from Python
 * to manage debugging tasks and log transitions between service instances.
 */

/**
 * @brief Called when entering a service instance.
 *
 * Increments the recursion level and logs the entry.
 *
 * @param pInstance Pointer to the service instance being entered.
 */
void Debugger::debugEnter(IServiceFilterInstance *pInstance,
                          const json::Value &trace) noexcept {
    m_recurseLevel++;  // Track depth of recursive calls

    if (::engine::config::monitor()->isAppMonitor()) {
        // Format it
        StackText msg;
        _tsbo(msg, {Format::HEX, {}, '*'}, "ENTER", pInstance->pipeId,
              pInstance->endpoint->getPipeCount(),
              pInstance->pipeType.logicalType, trace.stringify());

        ::engine::config::monitor()->other("DBG", msg);
    }
}

/**
 * @brief Called when leaving a service instance.
 *
 * Decrements the recursion level and logs the exit.
 *
 * @param pInstance Pointer to the service instance being exited.
 */
void Debugger::debugLeave(IServiceFilterInstance *pInstance,
                          const json::Value &trace) noexcept {
    m_recurseLevel--;

    if (::engine::config::monitor()->isAppMonitor()) {
        // Format it
        StackText msg;
        _tsbo(msg, {Format::HEX, {}, '*'}, "LEAVE", pInstance->pipeId,
              pInstance->endpoint->getPipeCount(),
              pInstance->pipeType.logicalType, trace.stringify());

        ::engine::config::monitor()->other("DBG", msg);
    }
}

/**
 * @brief Called when a break point is hit between two service instances.
 *
 * @param pFrom Pointer to the originating service instance.
 * @param pTo Pointer to the destination service instance.
 * @param methodName Name of the method or action being executed.
 */
void Debugger::debugBreak(IServiceFilterInstance *pFrom,
                          IServiceFilterInstance *pTo,
                          const std::string &methodName) noexcept {
    // If paused...
    if (taskIsPaused()) {
        // Paused is true, acquire lock and wait until resumed
        std::unique_lock<std::mutex> lock(m_pause_lock);
        m_pause_event.wait(lock, [this] { return !m_paused.load(); });
    }

    // Check if this should cause a breakpoint as well
}

/**
 * @brief Called when an error occurs between two service instances.
 *
 * @param pFrom Pointer to the originating service instance.
 * @param pTo Pointer to the destination service instance.
 * @param methodName Name of the method where the error occurred.
 * @param ccode Error object describing the failure.
 */
void Debugger::debugError(IServiceFilterInstance *pFrom,
                          IServiceFilterInstance *pTo,
                          const std::string &methodName,
                          Error &ccode) noexcept {
    LOG(DebugOut, ">DBG*ERROR*....");
    // Could log ccode and methodName for more detail if needed.
}

// ------------------ Task Control Methods ------------------

/// Get the task ID of the endpoint this debugger is associated with.
std::string Debugger::getTaskId() const noexcept {
    // Return the task ID of the endpoint this debugger is associated with
    auto endpoint = m_endpoint.lock();
    if (endpoint) {
        return endpoint->taskId;
    }
    return {};
}

/// Stop execution.
void Debugger::taskStop() noexcept { LOG(DebugOut, "taskStop called"); }

/// Break execution.
void Debugger::taskBreak() noexcept {
    // Protect the pause state with a lock
    std::lock_guard<std::mutex> lock(m_pause_lock);

    // Say we are pausing
    LOG(DebugOut, "Pausing task execution");
    m_paused.store(true, std::memory_order_release);
}

/// Resume execution.
void Debugger::taskResume() noexcept {
    // Protect the pause state with a lock
    std::lock_guard<std::mutex> lock(m_pause_lock);

    // Say we are resuming
    LOG(DebugOut, "Resuming task execution");
    m_paused.store(false, std::memory_order_release);
    m_pause_event.notify_all();
}

/// Return T/F if paused or not
bool Debugger::taskIsPaused() const noexcept {
    return m_paused.load(std::memory_order_acquire);
}

/// Step into the next instruction.
void Debugger::taskStep() noexcept { LOG(DebugOut, "taskStep called"); }

/// Step over the current instruction.
void Debugger::taskStepOver() noexcept { LOG(DebugOut, "taskStepOver called"); }

/// Step into the next instruction (alias or variation of `taskStep`).
void Debugger::taskStepIn() noexcept { LOG(DebugOut, "taskStepIn called"); }

// ------------------ Breakpoint Control Methods ------------------

/**
 * @brief Output a breakpoint to the log.
 *
 * @param msg The message to log.
 * @param bp The breakpoint to output.
 */
void Debugger::_outputBreakpoint(const std::string &msg,
                                 const Breakpoint &bp) noexcept {
    LOG(DebugOut, msg, "(enabled=", bp.enabled, ", from=", bp.from_id,
        ", to=", bp.to_id, ", lane=", bp.lane + ")");
}

/**
 * @brief Set all breakpoints at once, replacing the current set.
 *
 * This clears any existing breakpoints and sets new ones from the given vector.
 * Each breakpoint is logged upon being set.
 *
 * @param breakpoints Vector of Breakpoint objects to set.
 */
void Debugger::taskBreakpointSet(
    const std::vector<Breakpoint> &breakpoints) noexcept {
    std::lock_guard<std::mutex> lock(m_breakpoint_lock);

    m_breakpoints.clear();

    for (const auto &bp : breakpoints) {
        m_breakpoints.push_back(bp);
        _outputBreakpoint("Breakpoint set", bp);
    }
}

/**
 * @brief Add a breakpoint if it doesn't already exist.
 *
 * Checks if a breakpoint with the same from_id, to_id, and lane already exists.
 * If it does, logs and returns without adding.
 * Otherwise, adds a new enabled breakpoint.
 *
 * @param from_id Source instance identifier.
 * @param to_id Destination instance identifier.
 * @param lane Communication lane name.
 */
void Debugger::taskBreakpointAdd(const std::string &from_id, std::string to_id,
                                 std::string lane) noexcept {
    std::lock_guard<std::mutex> lock(m_breakpoint_lock);

    Breakpoint new_bp(true, from_id, std::move(to_id), std::move(lane));

    for (const auto &existing : m_breakpoints) {
        if (existing == new_bp) {
            _outputBreakpoint("Breakpoint already set", existing);
            return;  // Avoid duplicates
        }
    }

    _outputBreakpoint("Breakpoint added", new_bp);
    m_breakpoints.push_back(std::move(new_bp));
}

/**
 * @brief Remove a breakpoint.
 *
 * Searches for a breakpoint matching the specified from_id, to_id, and lane.
 * If found, removes it and logs the removal.
 * If not found, logs that no matching breakpoint was found.
 *
 * @param from_id Source instance identifier.
 * @param to_id Destination instance identifier.
 * @param lane Communication lane name.
 */
void Debugger::taskBreakpointRemove(const std::string &from_id,
                                    std::string to_id,
                                    std::string lane) noexcept {
    std::lock_guard<std::mutex> lock(m_breakpoint_lock);

    Breakpoint id(true, from_id, std::move(to_id), std::move(lane));

    auto it = std::remove_if(m_breakpoints.begin(), m_breakpoints.end(),
                             [&](const Breakpoint &bp) { return bp == id; });

    if (it != m_breakpoints.end()) {
        m_breakpoints.erase(it, m_breakpoints.end());
        _outputBreakpoint("Breakpoint removed", id);
    } else {
        _outputBreakpoint("No matching breakpoint found for removal", id);
    }
}

/**
 * @brief Enable a specific breakpoint.
 *
 * Finds the breakpoint matching the given parameters and sets its enabled flag
 * to true. Logs the enable action.
 *
 * @param from_id Source instance identifier.
 * @param to_id Destination instance identifier.
 * @param lane Communication lane name.
 */
void Debugger::taskBreakpointEnable(const std::string &from_id,
                                    std::string to_id,
                                    std::string lane) noexcept {
    std::lock_guard<std::mutex> lock(m_breakpoint_lock);

    Breakpoint id(true, from_id, std::move(to_id), std::move(lane));

    for (auto &bp : m_breakpoints) {
        if (bp == id) {
            bp.enabled = true;
            _outputBreakpoint("Breakpoint enabled", bp);
            return;
        }
    }

    _outputBreakpoint("No matching breakpoint found for enabling", id);
}

/**
 * @brief Disable a specific breakpoint.
 *
 * Finds the breakpoint matching the given parameters and sets its enabled flag
 * to false. Logs the disable action.
 *
 * @param from_id Source instance identifier.
 * @param to_id Destination instance identifier.
 * @param lane Communication lane name.
 */
void Debugger::taskBreakpointDisable(const std::string &from_id,
                                     std::string to_id,
                                     std::string lane) noexcept {
    std::lock_guard<std::mutex> lock(m_breakpoint_lock);

    Breakpoint id(true, from_id, std::move(to_id), std::move(lane));

    bool found = false;
    for (auto &bp : m_breakpoints) {
        if (bp == id) {
            bp.enabled = false;
            _outputBreakpoint("Breakpoint disabled", bp);
            found = true;
            break;
        }
    }
    if (!found) {
        _outputBreakpoint("No matching breakpoint found for disabling", id);
    }
}

/**
 * @brief Retrieve a thread-safe copy of the list of currently registered
 * breakpoints.
 *
 * Returns a vector of Breakpoint objects representing the current breakpoints.
 *
 * @return Vector of Breakpoint objects.
 */
std::vector<Breakpoint> Debugger::taskBreakpointList() noexcept {
    std::lock_guard<std::mutex> lock(m_breakpoint_lock);
    return m_breakpoints;
}

// ------------------ Static debugger management Methods ------------------

void Debugger::registerDebugger(ServiceEndpointWeak endpoint) {
    // Get  ptr to the endpoint
    auto pEndpoint = endpoint.lock();

    std::lock_guard<std::mutex> lock(s_registryMutex);

    pEndpoint->debugger.m_endpoint =
        endpoint;  // Store the weak reference to the endpoint
    s_debuggerRegistry[pEndpoint->taskId] = endpoint;
}

void Debugger::deregisterDebugger(const std::string &taskId) {
    std::lock_guard<std::mutex> lock(s_registryMutex);
    s_debuggerRegistry.erase(taskId);
}

Debugger *Debugger::getDebugger(const std::string &taskId) {
    std::lock_guard<std::mutex> lock(s_registryMutex);

    // Handle empty taskId
    if (taskId.empty()) {
        if (s_debuggerRegistry.empty()) {
            throw std::runtime_error("No debuggers registered");
        }
        if (s_debuggerRegistry.size() == 1) {
            // Return the only debugger available
            auto &pair = *s_debuggerRegistry.begin();
            auto endpoint = pair.second.lock();
            if (!endpoint) {
                throw std::runtime_error(
                    "Registered debugger endpoint has expired");
            }
            return &endpoint->debugger;
        } else {
            throw std::invalid_argument(
                "Multiple debuggers registered; taskId must be specified");
        }
    }

    // Lookup by taskId
    auto it = s_debuggerRegistry.find(taskId);
    if (it != s_debuggerRegistry.end()) {
        auto endpoint = it->second.lock();
        if (!endpoint) {
            throw std::runtime_error(
                "Registered debugger endpoint has expired");
        }
        return &endpoint->debugger;
    }

    throw std::runtime_error("Debugger not found for taskId: " + taskId);
}

std::vector<std::string> Debugger::listDebuggers() {
    std::lock_guard<std::mutex> lock(s_registryMutex);
    std::vector<std::string> result;
    result.reserve(s_debuggerRegistry.size());
    for (const auto &[taskId, _] : s_debuggerRegistry) {
        result.push_back(taskId);
    }
    return result;
}

}  // namespace engine::store
