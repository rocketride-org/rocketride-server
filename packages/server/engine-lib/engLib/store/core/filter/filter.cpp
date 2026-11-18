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
/// @brief Destructor for IServiceFilterGlobal.
/// @details
///     Forces end of global
//-------------------------------------------------------------------------
IServiceFilterGlobal::~IServiceFilterGlobal() {
    LOGPIPE();
    endFilterGlobal();
}

//-------------------------------------------------------------------------
/// @brief Enter the Python-call gate
/// @details
///     Fails when the filter's gate is closed. Otherwise counts the call as
///     in flight and takes the head of the stack. The flag is checked again
///     after the count is raised, so a teardown that sets the flag and then
///     reads the count never misses this call.
//-------------------------------------------------------------------------
IServiceFilterInstance::CallGuard::CallGuard(
    ServiceInstance filter) noexcept(false)
    : self(_mv(filter)) {
    if (self->hasEnded())
        throw APERR(Ec::PipelineEnded, PipelineEndedMessage);

    self->m_inFlight.fetch_add(1, std::memory_order_seq_cst);

    // Take the head while counted. The lock is for a guard that loses to
    // the teardown: its links may be reset while it copies. A stack that
    // waits for this count keeps its links until the count drops, so
    // leave() still reaches the head through the copy.
    bool linked = false;
    {
        std::lock_guard<std::mutex> lock(self->m_linkLock);
        pipe = self->pipe;
        linked = pipe && self->endpoint;
    }

    // Re-check while counted
    if (self->hasEnded() || !linked) {
        leave();
        throw APERR(Ec::PipelineEnded, PipelineEndedMessage);
    }
}

//-------------------------------------------------------------------------
/// @brief Leave the Python-call gate
//-------------------------------------------------------------------------
IServiceFilterInstance::CallGuard::~CallGuard() noexcept { leave(); }

//-------------------------------------------------------------------------
/// @brief Drop the count and release the stack if it waits for this call
/// @details
///     Every guard that raised the count leaves here, a refused one too: its
///     short count may be the one that kept armDeferredRelease() from
///     releasing the stack. The count drops before the head is let go, so
///     releasing the last owner of the stack never waits on its own call.
///     The head of the stack then releases the stack if it is waiting for
///     this call. The released endpoint is held until the head and the
///     filter are let go, so on this thread the stack's filters are freed
///     before their endpoint, as they are on a teardown that waited for
///     every call.
//-------------------------------------------------------------------------
void IServiceFilterInstance::CallGuard::leave() noexcept {
    self->m_inFlight.fetch_sub(1, std::memory_order_seq_cst);

    ServiceEndpoint released;
    if (pipe)
        released = pipe->releaseStackIfIdle();

    pipe.reset();
    self.reset();
}

//-------------------------------------------------------------------------
/// @brief Release the stack of a head filter that is armed and idle
/// @details
///     The chain is collected head-first before anything is released, so
///     the filters stay alive while their links are reset. The flag's
///     exchange makes the release happen once, whichever thread gets here.
///     The endpoint is returned to the caller, which lets it go after the
///     filters.
//-------------------------------------------------------------------------
ServiceEndpoint IServiceFilterInstance::releaseStackIfIdle() noexcept {
    if (!m_releaseOnIdle.load(std::memory_order_seq_cst))
        return {};

    // Declared before the chain, so it outlives the filters the chain drops
    ServiceEndpoint released;

    std::vector<ServiceInstance> chain;
    for (auto filter = instance.lock(); filter; filter = filter->downLink())
        chain.push_back(filter);

    uint32_t total = 0;
    for (const auto &filter : chain) total += filter->callsInFlight();
    if (total)
        return {};

    if (!m_releaseOnIdle.exchange(false, std::memory_order_seq_cst))
        return {};

    {
        std::lock_guard<std::mutex> lock(m_linkLock);
        released = endpoint;
    }

    // No lock is held here; dropping the chain may run filter destructors
    for (const auto &filter : chain) filter->releaseLinks();
    return released;
}

//-------------------------------------------------------------------------
/// @brief Arm the head filter for release on idle
/// @details
///     The flag is set first and the counts are read after, so a call that
///     returned while the stack was being ended is not missed. The endpoint
///     that a release returns is let go here at once. It is not freed here:
///     the stack is ended by endEndpoint() or by a pipe build, and their
///     caller still holds the endpoint.
//-------------------------------------------------------------------------
void IServiceFilterInstance::armDeferredRelease() noexcept {
    m_releaseOnIdle.store(true, std::memory_order_seq_cst);
    releaseStackIfIdle();
}

//-------------------------------------------------------------------------
/// @brief Read one filter of this pipe's instance stack
/// @details
///     Refuses with Ec::PipelineEnded when the stack no longer holds the
///     filter. The refusal is thrown after the stack lock is released.
//-------------------------------------------------------------------------
ServiceInstance IServiceFilterInstance::stackFilter(
    size_t filterId) const noexcept(false) {
    ServiceInstance filter;
    {
        util::Guard stackGuard{[&] { endpoint->m_stackLock.lock(); },
                               [&] { endpoint->m_stackLock.unlock(); }};

        if (pipeId < endpoint->m_instanceStacks.size()) {
            auto &stack = endpoint->m_instanceStacks[pipeId];
            if (filterId < stack.size())
                filter = stack[filterId];
        }
    }

    if (!filter)
        throw APERR(Ec::PipelineEnded, PipelineEndedMessage);
    return filter;
}

//-------------------------------------------------------------------------
/// @brief Begin using filter
//-------------------------------------------------------------------------
Error IServiceFilterGlobal::beginFilterGlobal() noexcept { return {}; }

//-------------------------------------------------------------------------
/// @brief Validate using filter
//-------------------------------------------------------------------------
Error IServiceFilterGlobal::validateConfig() noexcept { return {}; }

//-------------------------------------------------------------------------
/// @brief End use of a filter
/// @details
///     Cleans up allocated buffers and resets internal pointers.
//-------------------------------------------------------------------------
Error IServiceFilterGlobal::endFilterGlobal() noexcept {
    // Reset all of our ptrs
    endpoint.reset();
    global.reset();
    return {};
}

//-------------------------------------------------------------------------
/// @brief Destructor for IServiceFilterInstance.
/// @details
///     Forces an end instance
//-------------------------------------------------------------------------
IServiceFilterInstance::~IServiceFilterInstance() {
    LOGPIPE();

    // The destructor always releases the links, even if an earlier end was
    // skipped or failed
    m_retainLinks.store(false, std::memory_order_release);
    endFilterInstance();
}

//-------------------------------------------------------------------------
/// @brief Read the next filter down the chain under the link lock
//-------------------------------------------------------------------------
ServiceInstance IServiceFilterInstance::downLink() const noexcept {
    std::lock_guard<std::mutex> lock(m_linkLock);
    return pDown;
}

//-------------------------------------------------------------------------
/// @brief Begin using filter
//-------------------------------------------------------------------------
Error IServiceFilterInstance::beginFilterInstance() noexcept { return {}; }

//-------------------------------------------------------------------------
/// @brief End use of a filter
/// @details
///     Closes the gate, then releases the links and buffers, unless
///     retainLinksOnEnd() asked to keep them.
//-------------------------------------------------------------------------
Error IServiceFilterInstance::endFilterInstance() noexcept {
    // Refuse new Python callbacks before the links go away
    closeGate();

    // A call may still be running on this filter: keep every link and buffer,
    // the pipe filter's link to itself included, until releaseStackIfIdle()
    // or the destructor releases them. The call reads the links after it
    // returns (Binder::callMethods reads m_pInstance->pipe), so each one
    // must stay valid until the call has left the stack. The self link
    // closes a cycle; releaseLinks() breaks it.
    if (m_retainLinks.exchange(false, std::memory_order_acq_rel))
        return {};

    releaseLinks();
    return {};
}

//-------------------------------------------------------------------------
/// @brief Release the links and buffers of a filter
/// @details
///     Safe to call more than once.
//-------------------------------------------------------------------------
void IServiceFilterInstance::releaseLinks() noexcept {
    // Reset our owning ptrs. The weak self link stays: it owns nothing, expires
    // with the object, and handles of other filters read it (pipe->instance,
    // pDown->instance) while those filters are alive. The objects are
    // released after the lock is dropped, so their destructors never run
    // under it.
    ServiceEndpoint oldEndpoint;
    ServiceGlobal oldGlobal;
    ServicePipe oldPipe;
    ServiceInstance oldDown;
    {
        std::lock_guard<std::mutex> lock(m_linkLock);
        oldEndpoint = _mv(endpoint);
        oldGlobal = _mv(global);
        oldPipe = _mv(pipe);
        oldDown = _mv(pDown);
    }

    // Release the tag buffer if allocated
    if (m_pTagBuffer) Memory::release(&m_pTagBuffer);

    // Release the IO buffer if allocated
    if (m_pIOBuffer) Memory::release(&m_pIOBuffer);
}
}  // namespace engine::store
