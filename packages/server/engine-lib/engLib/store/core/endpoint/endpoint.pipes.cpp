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
template <typename T>
using Ptr = std::unique_ptr<T, void (*)(T *)>;

//-------------------------------------------------------------------------
/// @details
///		This function will walk through filter drivers and bind them to
///		each other: the up/down ptrs, then the per-connection data lanes.
///		Lifecycle (open/closing/close) is bound flat onto each region's root
///		in topological order - closing/close upstream-first, open reversed -
///		so a node is flushed/closed only after all of its upstream data
///		parents. The pipe head owns the source region; each control/invoke
///		node (e.g. tool_pipe) owns the sub-pipeline it reaches and drives it
///		through the same flat binding. Any node owned by no region keeps its
///		per-parent lifecycle binding. Called when we create the initial
///		filter stack.
///	@param[in]	pipeId
///		The pipe id this stack belongs to.
///	@param[in]	filters
///		The list of filters to bind; filters[0] is the pipe head.
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::bindFilters(size_t pipeId,
                                    ServiceInstanceStack &filters) noexcept {
    // Get our pipe filter
    ServiceInstance *pPipeFilter = &filters[0];

    // Now, walk through all of our filters and bind the pDown
    for (size_t index = 0; index < filters.size(); index++) {
        ServiceInstance downFilter;

        // Determine the down ptr
        if (index == filters.size() - 1)
            downFilter = nullptr;
        else
            downFilter = filters[index + 1];

        // Grab the index - I can't accout for it, but if we just send index
        // over itself, it gets the filter number + 1
        size_t filterId = index;

        // Bind all the linkages
        filters[index]->bindLinkages(
            pipeId,       // This pipe id
            filterId,     // The relative position in the stack
            downFilter);  // The next one in line
    }

    // If we are not in pipeline mode, or we are not a target
    if (!isPipeline()) return {};

    // Lifecycle (open/closing/close) binding is split in two. A node OWNED by a
    // region - the head's (lifecycleOrder) or a control root's
    // (controlLifecycleOrders) - gets its lifecycle driven flat from that
    // region's root in topological order (the flat binds after this loop). Any
    // node owned by NO region (a subgraph fed by neither the source nor an
    // invoked node) keeps its per-parent binding, without which it could not be
    // opened/closed at all. `owned` is the union of all regions, used to tell
    // the two apart below.
    std::unordered_set<int> owned(lifecycleOrder.begin(), lifecycleOrder.end());
    for (const auto &region : controlLifecycleOrders)
        owned.insert(region.second.begin(), region.second.end());

    // Define a map to track per-parent lifecycle binds (keyed by target)
    std::unordered_map<std::string, bool> boundConnections;
    for (auto &connection : this->connections) {
        // Get the from/to
        auto fromIndex = std::get<0>(connection);
        auto toIndex = std::get<1>(connection);
        auto lane = std::get<2>(connection);

        // If we are binding from the source, we will actually bind
        // to this pipe filter
        ServiceInstance *pFrom;
        if (fromIndex == -1)
            pFrom = pPipeFilter;
        else if (fromIndex < 0 || fromIndex >= filters.size())
            return APERR(Ec::InvalidParam,
                         "Bind to invalid from index: out of range");
        else
            pFrom = &filters[fromIndex];

        ServiceInstance *pTo;
        if (toIndex < 0 || toIndex >= filters.size())
            return APERR(Ec::InvalidParam,
                         "Bind to invalid to index: out of range");
        else
            pTo = &filters[toIndex];

        // Create a key using the target index
        std::string connectionKey = std::to_string(toIndex);

        // Bind the lifecycle lanes under the first parent ONLY for targets no
        // region owns - a region-owned node is driven flat by its root below,
        // so binding it per-parent too would call its lifecycle twice.
        if (owned.find(toIndex) == owned.end() &&
            boundConnections.find(connectionKey) == boundConnections.end()) {
            if (auto ccode = (*pFrom)->binder.bind("open", pTo->get()))
                return ccode;
            if (auto ccode = (*pFrom)->binder.bind("closing", pTo->get()))
                return ccode;
            if (auto ccode = (*pFrom)->binder.bind("close", pTo->get()))
                return ccode;

            // Add the key to the map to prevent re-binding
            boundConnections[connectionKey] = true;
        }

        // Bind the connection
        if (auto ccode = (*pFrom)->binder.bind(lane, pTo->get())) {
            return ccode;
        }
    }

    // Bind one region's lifecycle flat onto its root, in dependency order.
    // closing/close run upstream-first so flush-time output always lands on
    // consumers that have not flushed yet; open runs downstream-first (the
    // reverse) so a node emitting during its open callback reaches consumers
    // that are already open.
    auto bindLifecycle = localfcn(ServiceInstance * pRoot,
                                  const std::vector<int> &order)
                             ->Error {
        for (auto toIndex : order) {
            ServiceInstance *pTo = &filters[toIndex];
            if (auto ccode = (*pRoot)->binder.bind("closing", pTo->get()))
                return ccode;
            if (auto ccode = (*pRoot)->binder.bind("close", pTo->get()))
                return ccode;
        }
        for (auto it = order.rbegin(); it != order.rend(); ++it) {
            ServiceInstance *pTo = &filters[*it];
            if (auto ccode = (*pRoot)->binder.bind("open", pTo->get()))
                return ccode;
        }
        return {};
    };

    // Range-check every index the binds below dereference, up front: the walks
    // index `filters` directly, forwards and reversed, and a check inside one
    // of those loops would silently leave the others covered only by the order
    // they happen to run in.
    auto checkRange = localfcn(int index)->Error {
        if (index < 0 || (size_t)index >= filters.size())
            return APERR(Ec::InvalidParam,
                         "Lifecycle bind to invalid index: out of range");
        return {};
    };
    for (auto toIndex : lifecycleOrder)
        if (auto ccode = checkRange(toIndex)) return ccode;
    for (auto &region : controlLifecycleOrders) {
        if (auto ccode = checkRange(region.first)) return ccode;
        for (auto toIndex : region.second)
            if (auto ccode = checkRange(toIndex)) return ccode;
    }

    // The pipe head drives the source region; each control root drives its own
    // sub-pipeline region.
    if (auto ccode = bindLifecycle(pPipeFilter, lifecycleOrder)) return ccode;
    for (auto &region : controlLifecycleOrders)
        if (auto ccode = bindLifecycle(&filters[region.first], region.second))
            return ccode;

    // Add the control entry points
    for (auto &comp : this->controls) {
        // Get the from/to
        auto fromIndex = std::get<0>(comp);
        auto toIndex = std::get<1>(comp);
        auto classType = std::get<2>(comp);

        // If we are binding from the source, we will actually bind
        // to this pipe filter
        ServiceInstance *pFrom;
        if (fromIndex == -1)
            pFrom = pPipeFilter;
        else if (fromIndex < 0 || fromIndex >= filters.size())
            return APERR(Ec::InvalidParam,
                         "Control to invalid from index: out of range");
        else
            pFrom = &filters[fromIndex];

        ServiceInstance *pTo;
        if (toIndex < 0 || toIndex >= filters.size())
            return APERR(Ec::InvalidParam,
                         "Control to invalid to index: out of range");
        else
            pTo = &filters[toIndex];

        // If it does not exist, add it
        if ((*pFrom)->controller.find(classType) == (*pFrom)->controller.end())
            (*pFrom)->controller[classType] = {};

        // Add this to the list of controls
        (*pFrom)->controller[classType].push_back(toIndex);
    }

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Builds the global pipe
//-------------------------------------------------------------------------
Error IServiceEndpoint::buildGlobalPipe() noexcept {
    // Creates the global filter of one pipe stack entry and puts it at the
    // same position of the global stack, so the two stacks stay aligned
    const auto makeGlobal = [this](size_t index) -> Error {
        // Get the filter we are initalizing
        auto &filter = pipeStack[index];

        // Get a shared ptr from it
        auto thisEndpoint = this->endpoint.lock();

        // Create the filter
        auto result = Factory::make<IServiceFilterGlobal>(_location, filter,
                                                          thisEndpoint);
        if (!result) return result.ccode();

        // Release the ptr manually
        thisEndpoint = {};

        // Move it to a shared ptr
        ServiceGlobal global = _mv(*result);

        // Set the self referential weak ptr
        global->global = global;

        // Save it at the filter's position of the global stack
        m_globalStack.insert(m_globalStack.begin() + index, global);
        return {};
    };

    // Create all the global filters
    for (size_t i = 0; i < pipeStack.size(); ++i)
        if (auto ccode = makeGlobal(i)) return ccode;

    // In pipeline mode, validate all the global filters first, in order
    if (config.openMode == OPEN_MODE::PIPELINE) {
        for (auto global : m_globalStack) {
            // If the filter is not valid, stop
            if (auto ccode = global->validateConfig()) return ccode;
        }
    }

    // If we are not in config mode, begin the global filters
    if (config.openMode != OPEN_MODE::CONFIG &&
        config.openMode != OPEN_MODE::PIPELINE_CONFIG) {
        // Init and reset the pipeStackIndex
        util::Guard pipeStackIndexGuard{[this] { pipeStackIndex = 0; },
                                        [this] { pipeStackIndex = -1; }};

        // And then begin the global filters, in order. A filter may add
        // new ones behind itself while it begins (insertFilter): those get
        // their globals created and validated here, aligned with the pipe
        // stack, and are begun next in turn
        for (; _cast<size_t>(pipeStackIndex) < m_globalStack.size();
             ++pipeStackIndex) {
            const auto begun = pipeStackIndex;
            auto global = m_globalStack[begun];

            // If the beginFilterGlobal has an error, stop
            if (auto ccode = global->beginFilterGlobal()) return ccode;

            // insertFilter moved pipeStackIndex past each filter it added
            for (auto inserted = begun + 1; inserted <= pipeStackIndex;
                 ++inserted) {
                if (auto ccode = makeGlobal(_cast<size_t>(inserted)))
                    return ccode;

                if (config.openMode == OPEN_MODE::PIPELINE)
                    if (auto ccode = m_globalStack[inserted]->validateConfig())
                        return ccode;
            }

            // Resume at the first added filter, so it is begun in turn
            pipeStackIndex = begun;
        }
    }

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Builds an instance pipe and returns the vector of filters built
//-------------------------------------------------------------------------
ErrorOr<ServicePipe> IServiceEndpoint::buildInstancePipe() noexcept {
    Error ccode;
    size_t pipeId = 0;

    // Get the instance stack
    ServiceInstanceStack instanceStack;

    // Create the pipe ptr
    ServicePipe pipe = nullptr;

    // Create all the instance filters - call the begin as we go along
    // to allow them to add new drivers along the way
    for (size_t i = 0; i < pipeStack.size(); ++i) {
        // Get the filter we are initalizing
        auto &filter = pipeStack[i];

        // Get the driver in the global stack
        auto &global = m_globalStack[i];

        // Get shared ptrs to our endpoint and global
        auto thisGlobal = global->global.lock();
        auto thisEndpoint = endpoint.lock();

        // Create the filter - if we fail, we have cleanup work to do
        auto result = Factory::make<IServiceFilterInstance>(
            _location, filter, thisEndpoint, thisGlobal, pipe);
        if (!result) {
            ccode = result.ccode();
            break;
        }

        // Get the shared ptr
        ServiceInstance instance = _mv(*result);

        // Save the self referential weak ptr
        instance->instance = instance;

        // If this is the pipe
        if (i == 0) {
            // Try casting it to ServicePipe
            pipe =
                std::dynamic_pointer_cast<IServiceFilterInstancePipe>(instance);

            // If we did not get it, stop
            if (!pipe)
                return APERR(Ec::InvalidParam,
                             "The first filter in the stack must be the pipe");
        }

        // Save it into the pipe
        instance->pipe = pipe;

        // Begin the filter
        if (ccode = instance->beginFilterInstance()) {
            instance = {};
            break;
        }

        // Save it in the pipe stack
        instanceStack.push_back(instance);
    }

    // If we had an error in the pipe, we need to tell all drivers
    // to endFilterInstance so they can cleanup. This is mainly for
    // the parser which hangs on the thread.join if we don't do this
    if (ccode) {
        // Tell the filters to cleanup
        for (auto &filter : instanceStack) {
            // If we have a filter, end it
            if (filter) filter->endFilterInstance();
        }

        // And done
        return ccode;
    }

    _block() {
        // Lock the pipes - we are manipulating the pipe stacks
        util::Guard stackGuard{[&] { m_stackLock.lock(); },
                               [&] { m_stackLock.unlock(); }};

        // Get the index before pushing
        pipeId = m_instanceStacks.size();

        // Bind the filters
        if (ccode = bindFilters(pipeId, instanceStack)) return ccode;

        // Get a reference to the head - should be "pipe"
        ServiceInstance &filter = instanceStack[0];
        ServicePipe &pipe = (ServicePipe &)filter;

        // Mark as busy
        pipe->busy = true;

        // Save it in the pipe stack
        m_instanceStacks.push_back(_mv(instanceStack));

        // Return it
        return pipe;
    }
}

//-------------------------------------------------------------------------
/// @details
///		Returns the number of pipes
///	@returns
///		ErrorOr<int>
//-------------------------------------------------------------------------
int IServiceEndpoint::getPipeCount() noexcept {
    // Lock the pipes - we are manipulating the pipe stacks
    util::Guard stackGuard{[&] { m_stackLock.lock(); },
                           [&] { m_stackLock.unlock(); }};

    // Return the size of the stacks
    return static_cast<int>(m_instanceStacks.size());
}

//-------------------------------------------------------------------------
/// @details
///		Gets a pipe for the endpoint - the pipe is a stacked set
///		of filters that we can read from/write to. If no pipes
///		are available, one will be created
///		The pipe comes back as a new BINDING stamped with a traceId and a
///		trace level. With traceId 0 it starts a request tree: a fresh,
///		never-reused id from the process-wide counter. With a non-zero
///		traceId it joins that live tree: another slot stamped with THAT
///		SAME id, the tree's trace level, and the depth of the deepest busy
///		pipe holding the id plus one - so a sub-pipeline's trace reaches
///		the caller that caused it and the recursion guard counts the tree.
///	@param[in]	traceLevel
///		The trace level of this binding (ignored when joining a tree)
///	@param[in]	traceId
///		The live tree to join, or 0 to start a new one
///	@returns
///		ErrorOr<ServicePipe>
//-------------------------------------------------------------------------
ErrorOr<ServicePipe> IServiceEndpoint::getPipe(PIPELINE_TRACE_LEVEL traceLevel,
                                               uint64_t traceId) noexcept {
    // If we are not open, stop
    if (config.openMode == OPEN_MODE::NONE)
        return APERR(Ec::InvalidCommand,
                     "The endpoint is not open during call to getPipe");

    // The pipe gate may refuse the pipe
    if (pipeGate)
        if (auto ccode = pipeGate()) return ccode;

    // What the new binding inherits - the requested level and depth zero
    // for a new tree, unless a traceId is named: then the tree's level and
    // the depth of its deepest busy pipe plus one, so the recursion guard
    // counts the whole TREE (a node opening a sub-pipe that opens the node
    // again...) and not each pipe alone
    int bindDepth = 0;

    // Stamps the binding onto a pipe that is busy for us. Runs UNDER
    // m_stackLock: the tree lookup below reads these fields of every busy
    // pipe under the same lock, so a pipe is never visible as busy with the
    // previous holder's id. A new tree's id is minted from the process-wide
    // counter and never comes back; the slot (pipeId) does
    auto stamp = [&](ServicePipe &bound) noexcept {
        bound->traceId =
            traceId ? traceId
                    : s_nextTraceId.fetch_add(1, std::memory_order_relaxed);
        bound->traceLevel = traceLevel;
        bound->bindDepth = bindDepth;
    };

    // Find a pipe
    _block() {
        // Lock the pipes - we are manipulating the pipe stacks
        util::Guard stackGuard{[&] { m_stackLock.lock(); },
                               [&] { m_stackLock.unlock(); }};

        // A named tree must be live on this endpoint: take its level from
        // the deepest busy pipe holding the id
        if (traceId) {
            bool found = false;
            for (auto &stack : m_instanceStacks) {
                ServicePipe &holder = (ServicePipe &)stack[0];
                if (!holder->busy || holder->traceId != traceId) continue;
                int depth = holder->bindDepth.load() + 1;
                if (found && depth <= bindDepth) continue;
                traceLevel = holder->traceLevel;
                bindDepth = depth;
                found = true;
            }
            if (!found)
                return APERR(Ec::NotFound, "Trace is not live", traceId);

            // Refuse the join BEFORE a pipe (a whole filter stack) is
            // built or handed out for it: the tree is already at the limit
            if (bindDepth > filter::pipe::CONST_MAX_BIND_DEPTH)
                return APERR(Ec::Recursion,
                             "Pipeline binding depth exceeded",
                             filter::pipe::CONST_MAX_BIND_DEPTH,
                             "joining trace", traceId);
        }

        // Loop through them
        for (int i = 0; i < m_instanceStacks.size(); i++) {
            // Get this stack
            auto &stack = m_instanceStacks[i];

            // Get a reference to the head - should be "pipe"
            ServiceInstance &filter = stack[0];
            ServicePipe &pipe = (ServicePipe &)filter;

            // If it is busy, skip it
            if (pipe->busy) continue;

            // Mark as busy and bind it before anyone else can see it busy
            pipe->busy = true;
            stamp(pipe);

            // Return the bound pipe
            return pipe;
        }
    }

    // We don't have any available pipes, create one - it comes back busy
    auto result = buildInstancePipe();

    // If we got an error
    if (!result) return result.ccode();

    // Bind it under the same lock the tree lookup takes
    _block() {
        util::Guard stackGuard{[&] { m_stackLock.lock(); },
                               [&] { m_stackLock.unlock(); }};
        stamp(*result);
    }

    // Return the bound pipe
    return *result;
}

//-------------------------------------------------------------------------
/// @details
///		Gets a pipe bound at the endpoint's default trace level - the
///		task file's pipelineTraceLevel. This is the binding C++-driven
///		work (sources, scans) takes.
///	@returns
///		ErrorOr<ServicePipe>
//-------------------------------------------------------------------------
ErrorOr<ServicePipe> IServiceEndpoint::getPipe() noexcept {
    return getPipe(config.pipelineTraceLevel);
}

//-------------------------------------------------------------------------
/// @details
///		Seeds the high 16 bits of the process-wide traceId counter from
///		the launch's trace epoch; the low 48 bits count. EaaS assigns one
///		epoch per engine launch (monotonic per server process), so the
///		trace ids of two engines one connection holds never collide
///		(plan 7.4). Called for every endpoint the task configures; an
///		epoch already in effect is left alone, and 0 seeds nothing.
///	@param[in]	epoch
///		The launch's trace epoch (only the low 16 bits are used)
//-------------------------------------------------------------------------
void IServiceEndpoint::seedTraceEpoch(uint32_t epoch) noexcept {
    const uint64_t high = static_cast<uint64_t>(epoch & 0xFFFFu) << 48;
    if (!high) return;

    auto current = s_nextTraceId.load(std::memory_order_relaxed);
    while ((current >> 48) != (high >> 48)) {
        if (s_nextTraceId.compare_exchange_weak(current, high | 1,
                                                std::memory_order_relaxed))
            break;
    }
}

//-------------------------------------------------------------------------
/// @details
///		Releases a pipe back to the endpoint. This is called after
///		the operation on a specific object has completed and will
///		be returned to the queue for re-use
///	@param[in]	pipe
///		Reference to the pipe to release
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::putPipe(ServicePipe &pipe) noexcept {
    if (pipe->endpoint->config.openMode == OPEN_MODE::NONE)
        return APERR(Ec::InvalidCommand,
                     "The endpoint is not open during call to putPipe");

    // If the caller forgot to close the entry, do so now
    if (auto ccode = pipe->currentEntry) {
        // Get a referent because close will clear it
        auto &object = pipe->currentEntry;

        // Close it and save the error
        if (auto ccode = pipe->close()) object->completionCode(ccode);
    }

    // Release this pipe
    _block() {
        // Lock the pipes - we probably don't have to lock here,
        // but do so just in case
        util::Guard stackGuard{[&] { m_stackLock.lock(); },
                               [&] { m_stackLock.unlock(); }};

        // Mark as not busy
        pipe->busy = false;
    }

    return {};
}

}  // namespace engine::store
