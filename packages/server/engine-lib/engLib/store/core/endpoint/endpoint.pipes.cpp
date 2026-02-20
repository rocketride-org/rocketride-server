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

namespace engine::store {
template <typename T>
using Ptr = std::unique_ptr<T, void (*)(T *)>;

//-------------------------------------------------------------------------
/// @details
///		This function will walk through filter drivers and bind them to
///		each other, the up/down ptrs, top bottom, etc. This is called
///		when we create our initial filter stack, and also, when we
///		start/stop tracting.
///	@param[in]	filters
///		The list of filters to bind. It will be either the m_filters
///		which are the actual filters, or the m_tracers which will be
///		the tracers wrapped around the filters
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

    // Define a map to track bound connections (fromName + toName)
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

        // Create a key using fromName + toName
        std::string connectionKey = std::to_string(toIndex);

        // Check if this connection has already been bound
        if (boundConnections.find(connectionKey) == boundConnections.end()) {
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
    // Create all the global filters - call the begin as we go along
    // to allow them to add new drivers along the way
    for (size_t i = 0; i < pipeStack.size(); ++i) {
        // Get the filter we are initalizing
        auto &filter = pipeStack[i];

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

        // We need to process autopipe first, as it adds new filters
        if (filter.logicalType == "autopipe") {
            // In pipeline mode, validate autopipe first
            if (config.openMode == OPEN_MODE::PIPELINE) {
                // If the filter is not valid, stop
                if (auto ccode = global->validateConfig()) return ccode;
            }

            // Init and reset the pipeStackIndex
            util::Guard pipeStackIndexGuard{[&] { pipeStackIndex = i; },
                                            [&] { pipeStackIndex = -1; }};

            // Begin the autopipe
            if (auto ccode = global->beginFilterGlobal()) return ccode;
        }

        // Save it in the pipe stack
        m_globalStack.push_back(global);
    }

    // In pipeline mode, validate all the global filters first
    if (config.openMode == OPEN_MODE::PIPELINE) {
        for (auto global : m_globalStack) {
            if (global->pipeType.logicalType == "autopipe")
                continue;  // Skip autopipe, it is already validated

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

        // And then begin the global filters
        for (; _cast<size_t>(pipeStackIndex) < m_globalStack.size();
             ++pipeStackIndex) {
            auto global = m_globalStack[pipeStackIndex];

            if (global->pipeType.logicalType == "autopipe")
                continue;  // Skip autopipe, it is already begun

            // If the beginFilterGlobal has an error, stop
            if (auto ccode = global->beginFilterGlobal()) return ccode;
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
///	@returns
///		ErrorOr<ServicePipe>
//-------------------------------------------------------------------------
ErrorOr<ServicePipe> IServiceEndpoint::getPipe() noexcept {
    // If we are not open, stop
    if (config.openMode == OPEN_MODE::NONE)
        return APERR(Ec::InvalidCommand,
                     "The endpoint is not open during call to getPipe");

    // Find a pipe
    _block() {
        // Lock the pipes - we are manipulating the pipe stacks
        util::Guard stackGuard{[&] { m_stackLock.lock(); },
                               [&] { m_stackLock.unlock(); }};

        // Loop through them
        for (int i = 0; i < m_instanceStacks.size(); i++) {
            // Get this stack
            auto &stack = m_instanceStacks[i];

            // Get a reference to the head - should be "pipe"
            ServiceInstance &filter = stack[0];
            ServicePipe &pipe = (ServicePipe &)filter;

            // If it is busy, skip it
            if (pipe->busy) continue;

            // Mark as busy
            pipe->busy = true;

            // Return the pipe
            return pipe;
        }
    }

    // We don't have any available pipes, create one
    auto result = buildInstancePipe();

    // If we got an error
    if (!result) return result.ccode();

    // Return the pipe we just created
    return *result;
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
