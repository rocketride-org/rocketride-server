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

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Destructor - ends the endpoint
//-------------------------------------------------------------------------
IServiceEndpoint::~IServiceEndpoint() {
    LOGPIPE();

    // Remove it if we are registered
    Debugger::deregisterDebugger(taskId);

    // Stop
    endEndpoint();
};

//-------------------------------------------------------------------------
/// @details
///		Sets up the endpoint
///	@param[in]	openMode
///		The open mode. Will be either READ or WRITE
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::beginEndpoint(OPEN_MODE _openMode) noexcept {
    Error ccode;

    LOGPIPE();

    // Should not be opened
    if (config.openMode != OPEN_MODE::NONE)
        return APERR(Ec::InvalidCommand, "Endpoint already open");

    // Set/reset open mode
    util::Guard pipes{[&] { config.openMode = _openMode; },
                      [&] {
                          if (ccode) config.openMode = OPEN_MODE::NONE;
                      }};

    // Get the pipe stack to create
    if (ccode = buildPipeStack()) return ccode;

    // If we are actually starting the endpoint, we need to build
    // the global pipe and the connectoions
    if (!this->m_stackOnly) {
        // Build the global pipe
        if (ccode = buildGlobalPipe()) return ccode;

        // We have now finalized all of our stack components, so we
        // can build the connection list
        if (ccode = buildConnections()) return ccode;

        // Build the breakpoint list
        if (ccode = buildBreakpoints()) return ccode;
    }

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Sets up the endpoint
///	@param[in]	openMode
///		The open mode. Will be either READ or WRITE
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::signal(const Text &signal,
                               json::Value &param) noexcept {
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		The deadline of the waits of endEndpoint(), for Python calls that
///		are still running on its filters and then for pipe builds, all
///		together; and of the wait of a pipe build that is not published,
///		for the calls on its filters. A wait is checked every 50 ms, so it
///		can run one check over its share. It equals the value of the
///		engine's cancel fail-safe, async::globalCancelFailsafe(), and is
///		deliberately a separate constant: a fail-safe of 0 means "exit at
///		once" and must not turn the drain into a zero wait.
//-------------------------------------------------------------------------
Atomic<time::Duration> &IServiceEndpoint::drainDeadline() noexcept {
    static Atomic<time::Duration> deadline{10s};
    return deadline;
}

//-------------------------------------------------------------------------
/// @details
///		Waits while busy() returns true, for the given budget; the time
///		spent is taken off the budget. It checks every 50 ms, so it can
///		end one check after the budget ran out. The wait ends early on a
///		cancel: the calling thread was cancelled, or the global cancel
///		flag is set. The GIL is released for the wait when Python is up
///		and this thread holds it, so the work being waited for can
///		finish. Nothing sleeps and the GIL is not touched when busy() is
///		false at the first check.
///	@param[in]	busy
///		True while there is work to wait for. It is called with no lock
///		of this function held, with or without the GIL
///	@param[in,out]	budget
///		The time left to wait; reduced by the time this call waited
///	@returns
///		true when busy() turned false, false when the budget ran out or
///		the wait was cancelled while busy() was still true
//-------------------------------------------------------------------------
bool IServiceEndpoint::waitWhile(const std::function<bool()> &busy,
                                 time::Duration &budget) noexcept {
    // Normal case: nothing to wait for, no wait
    if (!busy())
        return true;

    const auto start = time::now();
    {
        engine::python::UnlockPythonIfHeld unlock;

        while (busy()) {
            if (time::now() - start >= budget)
                break;
            if (async::cancelled())
                break;
            async::sleep(50ms);
        }
    }

    // Charge the waiting time to the budget
    const auto spent = time::now() - start;
    budget = spent >= budget ? time::Duration{0s}
                             : time::Duration{budget - spent};

    return !busy();
}

//-------------------------------------------------------------------------
/// @details
///		Waits until no Python call is running on any of the given filters,
///		for the given budget, with waitWhile(). Whether the call gates are
///		open or closed is up to the caller. Neither the stack lock nor a
///		filter link lock is held while waiting.
///	@param[in]	filters
///		The filters to watch
///	@param[in,out]	budget
///		The time left to wait; reduced by the time this call waited
///	@returns
///		true when no call is in flight any more, false when the budget ran
///		out or the wait was cancelled with calls still running
//-------------------------------------------------------------------------
bool IServiceEndpoint::drainInFlightCalls(
    const std::vector<ServiceInstance> &filters,
    time::Duration &budget) noexcept {
    const auto inFlight = [&]() noexcept {
        for (const auto &filter : filters)
            if (filter->callsInFlight())
                return true;
        return false;
    };
    return waitWhile(inFlight, budget);
}

//-------------------------------------------------------------------------
/// @details
///		Ends the given globals, the last one first, and empties the
///		stack. In a config open mode they are let go without being ended.
///	@param[in,out]	globals
///		The globals to end; empty on return
///	@param[in]	openMode
///		The open mode the endpoint had when its end started
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::endGlobalStack(ServiceGlobalStack &globals,
                                       OPEN_MODE openMode) noexcept {
    Error ccode;
    while (!globals.empty()) {
        // Get the last filter
        auto filter = _mv(globals.back());
        globals.pop_back();

        // Close it if we are not in config mode
        if (openMode != OPEN_MODE::CONFIG &&
            openMode != OPEN_MODE::PIPELINE_CONFIG)
            ccode = filter->endFilterGlobal() || ccode;
    }
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Ends the filters of one instance stack, the last filter first, and
///		empties the stack. When a Python call may still run on the stack,
///		every filter keeps its links and the head is armed, so the last
///		call to leave the stack releases it.
///	@param[in,out]	stack
///		The filters to end; empty on return
///	@param[in]	drained
///		True when no Python call is in flight on the stack
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::endInstanceStack(ServiceInstanceStack &stack,
                                         bool drained) noexcept {
    Error ccode;

    // The head filter, kept to arm the deferred release below
    ServiceInstance head = stack.empty() ? ServiceInstance{} : stack.front();

    // For each filter in this instance stack
    while (!stack.empty()) {
        // Get the last filter
        auto filter = _mv(stack.back());
        stack.pop_back();

        // A call that outlived the drain keeps working on its filter and
        // on the binder chain below it, so the links stay until the
        // last holder of the filter lets go
        if (!drained)
            filter->retainLinksOnEnd();

        // Tell the filter to end
        ccode = filter->endFilterInstance() || ccode;
    }

    // All filters of this stack are ended; release the stack when idle
    if (!drained && head)
        head->armDeferredRelease();
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Destructs or ends the endpoint access.
///
///		Python calls into the engine are drained in phases so that a filter's
///		links are reset only when no call can still use them:
///		  1. Under the stack lock, stop handing out pipes and snapshot the
///		     filters. No stack is published after this, so the snapshot
///		     holds every stack that step 5 ends.
///		  2. Wait, gates open, until no call is in flight or half of the
///		     deadline has passed.
///		  3. Close the gate of every filter. A new call is refused from here
///		     on; a call that counted itself before its gate closed is seen by
///		     the next read (the call raises the count and then checks the
///		     flag, teardown sets the flag and then reads the count).
///		  4. Read the count again and wait, for the rest of the deadline, for
///		     the calls still in flight: one that ran through step 2, or one
///		     that got in just before its gate closed.
///		  5. Take the stacks out under the stack lock and end the filters.
///		     If a call is still running, the filters are ended with their
///		     links retained and then the head of each stack is armed; the
///		     last call to leave a stack releases it (at once if it is
///		     already idle).
///		  6. Wait, for what the two waits left of the deadline, until no
///		     pipe build runs: a build reads the globals and makes its
///		     filters from them. A build that is past the snapshot is
///		     refused and ends its own stack before it leaves.
///		  7. End the globals. If a build still runs, they stay in place
///		     and the last build to leave ends them (leaveBuild()).
///		Last, the task is let go: it may be freed once this returns.
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::endEndpoint() noexcept {
    Error ccode;

    LOGPIPE();

    // Clear our selection info
    deinitSelections();

    // Clear the target (if any)
    target = {};

    // Stop handing out pipes, and copy the filters as they are now, in one
    // hold of the stack lock
    std::vector<ServiceInstance> filters;
    {
        util::Guard stackGuard{[&] { m_stackLock.lock(); },
                               [&] { m_stackLock.unlock(); }};
        m_ending = true;
        for (const auto &stack : m_instanceStacks)
            for (const auto &filter : stack)
                if (filter)
                    filters.push_back(filter);
    }

    // Let the calls that are running return, gates open. The deadline is read
    // once for the whole teardown. This wait gets half of it (it checks every
    // 50 ms, so it can run one check over): new calls keep coming in while
    // the gates are open, and the wait with the gates closed must always
    // have time left for the calls already inside.
    const auto deadline = drainDeadline().load();
    const time::Duration openShare{deadline.asNanoseconds() / 2};
    auto openBudget = openShare;
    drainInFlightCalls(filters, openBudget);

    // Refuse new calls, then wait for the calls still in flight: a call that
    // got in before its gate closed is already counted and holds valid links
    // until it returns. This wait gets the other half and what the first
    // wait did not use.
    for (const auto &filter : filters) filter->closeGate();
    auto budget = deadline - openShare + openBudget;
    bool drained = drainInFlightCalls(filters, budget);

    if (!drained) {
        // Name the filters whose calls did not return
        Text names;
        uint32_t total = 0;
        for (const auto &filter : filters) {
            const auto count = filter->callsInFlight();
            if (!count)
                continue;
            total += count;
            names += _ts(" ", filter->pipeType.id, "(pipe ", filter->pipeId,
                         ", ", count, ")");
        }
        // A guard that passed its first gate check just before the gate
        // closed counts itself for an instant and is then refused. With the
        // gates closed no call can start, so a recount of zero means that
        // the drain saw only such a guard: no call holds the links.
        if (!total) {
            drained = true;
        } else if (async::cancelled()) {
            // A cancel cuts the drain short; otherwise the whole deadline
            // was waited
            LOG(Always, "Warning: teardown:", total,
                "Python call(s) still in flight (cancel requested, the drain",
                "was cut short); ending the filters without releasing their",
                "links:", names);
        } else {
            LOG(Always, "Warning: teardown:", total,
                "Python call(s) still in flight after", deadline,
                "; ending the filters without releasing their links:", names);
        }
    }

    // Drop the snapshot's references, so the last holder of a stack frees it
    filters.clear();

    // Take the stacks out under the stack lock. Ending a filter calls into
    // Python, so the filters are ended after the lock is released.
    ServiceInstanceStacks stacks;
    {
        util::Guard stackGuard{[&] { m_stackLock.lock(); },
                               [&] { m_stackLock.unlock(); }};
        stacks = _mv(m_instanceStacks);
        m_instanceStacks.clear();
    }

    // Destroy all the instance pipes and their filters we created,
    // even if we are not open
    while (!stacks.empty()) {
        // Get the last stack
        auto instanceStack = _mv(stacks.back());
        stacks.pop_back();

        ccode = endInstanceStack(instanceStack, drained) || ccode;
    }

    // A pipe build reads m_globalStack and makes its filters from the
    // globals, so they are ended only when no build runs. This wait gets
    // what the two waits above left of the deadline.
    waitWhile([&] { return buildsInProgress() != 0; }, budget);

    // Take the globals out under the stack lock, or leave them to the last
    // build if one still runs. A second end keeps the first one's mode.
    ServiceGlobalStack globals;
    uint32_t building = 0;
    {
        util::Guard stackGuard{[&] { m_stackLock.lock(); },
                               [&] { m_stackLock.unlock(); }};
        building = m_building;
        if (!building) {
            globals = _mv(m_globalStack);
            m_globalStack.clear();
        } else if (!m_globalsEndMode) {
            m_globalsEndMode = config.openMode;
        }
    }

    if (building) {
        if (async::cancelled()) {
            LOG(Always, "Warning: teardown:", building,
                "pipe build(s) still running (cancel requested, the wait",
                "was cut short); the last build to return ends the globals");
        } else {
            LOG(Always, "Warning: teardown:", building,
                "pipe build(s) still running after", deadline,
                "; the last build to return ends the globals");
        }
    }

    // End the globals taken out above, even if we are not open
    ccode = endGlobalStack(globals, config.openMode) || ccode;

    // End it
    config.openMode = OPEN_MODE::NONE;

    // Let go of the task last: a global's end may still write to it
    {
        std::lock_guard<async::Mutex> lock(m_taskLock);
        m_task = nullptr;
    }
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Static function to easily get the major type of the endpoint
///	@param[in]	serviceSection
///		The service section
///	@returns
///		Error
//-------------------------------------------------------------------------
ErrorOr<Text> IServiceEndpoint::getLogicalType(
    const json::Value &serviceConfig) noexcept {
    // Look up the type
    Text type = serviceConfig.lookup<iText>("type").lowerCase();

    // Split off the :// if it is there
    const auto parsed = type.split(':');

    // Prevent a crash
    if (parsed.size() < 1)
        return APERR(Ec::InvalidCommand, "Endpoint type not specified");

    // Return the type without the ://
    return parsed[0];
}

//-------------------------------------------------------------------------
/// @details
///		Gets the physical node type. For example, given ms-ondrive,
///		this returns python, or given filesys, it will return filesys
///	@param[in]	serviceConfig
///		The service section
//-------------------------------------------------------------------------
ErrorOr<Text> IServiceEndpoint::getPhysicalType(
    const json::Value &serviceConfig) noexcept {
    // Get the type specified
    auto type = IServiceEndpoint::getLogicalType(serviceConfig);
    if (!type) return type.ccode();

    // Get our service definition if we have one, if we don't just
    // return the logical type
    auto service = IServices::getServiceDefinition(*type);
    if (!service) return service.ccode();

    // Return the physical type
    return (*service)->physicalType;
}

//-------------------------------------------------------------------------
/// @details
///		Static function to easily create an endpoint
/// @param[in]	endpointMode
///		The mode of the endpoint
///	@param[in]	param
///		The parameters for the endpoint
//-------------------------------------------------------------------------
ErrorOr<ServiceEndpoint> IServiceEndpoint::getEndpoint(
    ENDPOINT_MODE endpointMode, ENDPOINT_PARAM &param) noexcept {
    // If there is no service config
    auto defaultServiceConfig = json::Value();

    // Based on the mode
    switch (endpointMode) {
        case ENDPOINT_MODE::SOURCE: {
            // We need a source endpoint - generate it
            defaultServiceConfig = R"(
                        {
                            "key": "null://*",
                            "name": "Null endpoint",
                            "type": "null",
                            "mode": "source",
                            "parameters": {}
                        }
                    )"_json;
            break;
        }

        case ENDPOINT_MODE::TARGET: {
            // We need a target endpoint - generate it
            defaultServiceConfig = R"(
                        {
                            "key": "null://*",
                            "name": "Null endpoint",
                            "type": "null",
                            "mode": "target",
                            "parameters": {}
                        }
                    )"_json;
        }
    }

    // Check the job config
    if (!param.jobConfig.has_value() || param.jobConfig.value().get().isNull())
        return APERR(Ec::InvalidCommand, "Job configuration is required");

    // Get the job config
    auto jobConfig = param.jobConfig.value().get();
    if (!jobConfig.isObject() || !jobConfig.isMember("taskId") ||
        !jobConfig["taskId"].isString())
        return APERR(Ec::InvalidCommand,
                     "taskId is required in your job configuration");

    // Get the task id
    auto taskId = jobConfig["taskId"].asString();

    // If there is no service config, use the null endpoint
    // Null is also a value, check for null explicitly
    if (!param.serviceConfig.has_value() ||
        param.serviceConfig.value().get().isNull())
        param.serviceConfig = defaultServiceConfig;

    // Get the type specified
    auto logicalType = IServiceEndpoint::getLogicalType(*param.serviceConfig);
    if (!logicalType) return logicalType.ccode();

    // Get the type specified
    auto physicalType = IServiceEndpoint::getPhysicalType(*param.serviceConfig);
    if (!physicalType) return physicalType.ccode();

    // Setup the pipe info
    IPipeType pipe{*logicalType, *logicalType, *physicalType};

    // Make the endpoint
    auto result = Factory::make<IServiceEndpoint>(_location, pipe);
    if (!result) return result.ccode();

    // Move it to a shared ptr
    ServiceEndpoint endpoint = _mv(*result);

    // Set the taskId
    endpoint->taskId = taskId;

    // Set the self referential weak ptr
    endpoint->endpoint = endpoint;

    // Save the endpoint mode
    endpoint->config.endpointMode = endpointMode;

    // Get our service definition if we have one, if we don't just
    // return the logical type
    auto service = IServices::getServiceDefinition(*logicalType);
    if (!service) return service.ccode();

    // Save the capabilities
    endpoint->capabilities = (*service)->capabilities;

    // Decode everything
    if (auto ccode = endpoint->setConfig(*param.jobConfig, *param.taskConfig,
                                         *param.serviceConfig))
        return ccode;

    // Save the request to the get pipe stack only - not begin it
    endpoint->m_stackOnly = param.stackOnly;

    // If we are in debug mode, bind the debugger
    if (param.debug) {
        // Bind it to this endpoint
        Debugger::registerDebugger(endpoint);
    }

    // If an open mode was specified, open it
    if (param.openMode != OPEN_MODE::NONE) {
        // Begin operations
        if (auto ccode = endpoint->beginEndpoint(param.openMode)) return ccode;

        // If we are a sync style driver, open the key value store
        if (endpoint->capabilities & Url::PROTOCOL_CAPS::SYNC) {
            // Key-Value storage
            if (auto ccode = endpoint->openKeyValueStorage()) return ccode;
        }
    }

    // And return the new endpoint
    return endpoint;
}

//-------------------------------------------------------------------------
/// @details
///		Static function to easily create an endpoint
///	@param[in]	param
///		The parameters for the endpoint
//-------------------------------------------------------------------------
ErrorOr<ServiceEndpoint> IServiceEndpoint::getSourceEndpoint(
    ENDPOINT_PARAM &&param) noexcept {
    return getEndpoint(ENDPOINT_MODE::SOURCE, param);
}

//-------------------------------------------------------------------------
/// @details
///		Static function to easily create an endpoint
///	@param[in]	param
///		The parameters for the endpoint
//-------------------------------------------------------------------------
ErrorOr<ServiceEndpoint> IServiceEndpoint::getTargetEndpoint(
    ENDPOINT_PARAM &&param) noexcept {
    return getEndpoint(ENDPOINT_MODE::TARGET, param);
}

//-------------------------------------------------------------------------
/// @details
///		Inserts a filter into the pipe. This is only valid during
///     beginGlobal
///	@param[in]	filter
///		Name of filter to instantiate
/// @param[in]  config
///     Configuration of the filter
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::insertFilter(const Text &filterName,
                                     const json::Value &filterConfig) {
    // Check to make sure this is a valid op
    if (pipeStackIndex < 0)
        throw APERR(Ec::InvalidCommand, "Only available during beginGlobal");

    // Create the filter object
    IPipeType filter;
    filter.id = filterName;
    filter.logicalType = filterName;
    filter.physicalType = filterName;
    filter.connConfig = filterConfig;

    // Ensure pipeStack is valid and insert the filter at the specified index
    if (pipeStackIndex < 0 || _cast<size_t>(pipeStackIndex) > pipeStack.size())
        throw APERR(Ec::OutOfRange, "Invalid pipe stack index");

    // Insert the filter at the current index
    pipeStack.insert(pipeStack.begin() + pipeStackIndex + 1, _mv(filter));

    // Increment the index after the insertion
    pipeStackIndex++;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Open the endpoints key value store
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::openKeyValueStorage() noexcept {
    // get keystore parameter
    Text keyStoreUrlText;
    if (auto ccode =
            config.taskConfig.lookupAssign("keystore", keyStoreUrlText))
        return ccode;
    if (keyStoreUrlText.empty()) return {};

    // open keystore
    Url keyStoreUrl{keyStoreUrlText};
    Text subKey;
    if (auto ccode = getConfigSubKey(subKey)) return ccode;
    if (!subKey)
        return APERR(Ec::InvalidCommand,
                     "Configuration subkey is required to open key store");
    // Key format would consists from
    //  - the physical type of the endpoint
    //  - the logical type of the endpoint
    //  - the config subkey for the endpoint
    // For example, `python_ms-sharepoint_` where
    //  - `python` is the physical type of the endpoint
    //  - `ms-sharepoint` is the logical type of the endpoint
    //  - `` (empty string) is the config subkey for the endpoint (empty in case
    //  of SharePoint online)
    Text serviceKey =
        _ts(config.physicalType, "_", config.logicalType, "_", subKey);
    LOGT("Opening keystore with key", serviceKey);
    if (auto ccode = keystore::open(keyStoreUrl, serviceKey); ccode.hasCcode())
        return ccode.ccode();
    else
        m_keyStore = _mv(*ccode);

    return {};
}

}  // namespace engine::store