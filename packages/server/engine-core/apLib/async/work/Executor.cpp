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

#include <apLib/ap.h>

namespace ap::async::work {

// Construct with a name, the name is used for logging operations on
// a specific executor
Executor::Executor(Text name) noexcept : m_name(_mv(name)) {}

// The destructor joins on all the work threads and deinitializes
// the executor
Executor::~Executor() noexcept { deinit(); }

// Submit a new work, given a location, name for debugging, and a
// bound callback
ErrorOr<Item> Executor::submit(Location location, Text name,
                               Callback &&cb) noexcept {
    if (async::cancelled()) return async::cancelled(_location);

    auto work = makeShared<ItemCtx>(*this, location, _mv(name), _mv(cb));

    if (auto ec = work->setState(ItemState::Submit)) {
        auto ccode = APERRT(ec, "Failed to set task state", work);
        work->setState(ItemState::Complete, ccode);
        return ccode;
    }

    if (auto ec = m_queue.push(work)) {
        auto ccode = APERRT(ec, "Failed to add task to queue", work);
        work->setState(ItemState::Complete, ccode);
        return ccode;
    }

    return Item{_mv(work)};
}

// Deinitializes this executor
void Executor::deinit() noexcept {
    if (!m_threads.empty()) LOGT("Deinitializing");

    m_queue.cancel();
    for (auto &t : m_threads) t.cancel();
    for (auto &t : m_threads) t.stop();
    m_threads.clear();

    for (auto &witem : m_queue) {
        if (auto work = witem.lock())
            work->setState(ItemState::Complete,
                           APERRT(Ec::Cancelled, "Executor deinitialized"));
    }

    m_queue.reset();
}

// Initialize this executor
Error Executor::init(uint32_t threadCount, size_t maxTasks) noexcept {
    deinit();

    if (!threadCount)
        return APERRT(Ec::InvalidParam, "Require at least 1 thread");

    m_queue.reset(maxTasks);

    LOGT("Initializing with {} threads", threadCount);

    for (auto i = 0u; i < threadCount; i++)
        m_threads.emplace_back(_location, _ts(m_name, " #", i),
                               std::bind(&Executor::serviceLoop, this));

    for (auto &thread : m_threads) {
        if (auto ccode = thread.start()) return ccode;
    }

    return {};
}

// This is the method that each work thread runs once started
void Executor::serviceLoop() noexcept {
    while (auto witem = m_queue.pop()) {
        // See if its still a valid context
        auto work = witem->lock();
        if (!work) continue;

        // Logically lock it as we transition states
        auto guard = work->lock();

        // Try and transition to execute, if canceled mark complete
        // and move on
        if (work->setState(ItemState::Execute)) {
            work->setState(ItemState::Complete,
                           Error{Ec::Cancelled, _location, "Work canceled"});
            continue;
        }

        // Now that we're in execute mode, unlock and execute
        guard = {};

        LOGT("Servicing item: {}", work);

        // Push the task context to the top of our thread stack, this
        // will allow global cancel checks to apply only to this task
        // for the duration of its execution
        ThreadApi::thisCtx()->push(work.get());
        auto ccode = work->m_callback.invoke(_location);
        ThreadApi::thisCtx()->pop();

        LOGT("Completed servicing item: {} ({})", work, ccode);

        work->setState(ItemState::Complete, _mv(ccode));
    }
}

}  // namespace ap::async::work
