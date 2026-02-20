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

namespace ap::async {

// A queue is a waitable stack where items may be pushed, while
// waiters may be waiting on a pop
template <typename T>
class Queue {
public:
    // Construct the queue, set a max to block push calls
    Queue(size_t maxDepth = MaxValue<size_t>) noexcept
        : m_max(std::max<size_t>(1, maxDepth)) {}

    // Construct the queue, set a max to block push calls, share a lock
    Queue(MutexLock &lock, size_t maxDepth = MaxValue<size_t>) noexcept
        : m_max(std::max<size_t>(1, maxDepth)), m_lock(lock) {}

    Queue(Queue &queue, size_t maxDepth = MaxValue<size_t>) noexcept
        : m_max(std::max<size_t>(1, maxDepth)), m_lock(queue.m_lock) {}

    Queue(Queue &&queue) noexcept : m_items(_mv(queue.m_items)) {}

    ~Queue() noexcept {}

    void setDepth(size_t maxDepth = MaxValue<size_t>) {
        m_max = std::max<size_t>(1, maxDepth);
    }

    // Locks this queue
    auto lock() const noexcept { return m_lock.acquire(); }

    // Waits for all items to be popped off the queue
    Error flush(bool setCompleted = true) noexcept {
        auto guard = lock();
        if (auto ec = m_condPop.wait(guard, [this]() noexcept {
                return m_items.empty() || m_cancelled;
            })) {
            cancel(APERR(ec));
            return *m_cancelled;
        }

        if (m_cancelled) return *m_cancelled;

        if (setCompleted) complete();
        return {};
    }

    // Waits for all items to be popped off the queue
    Error flush(time::Duration maxWait, bool setCompleted = true) noexcept {
        auto guard = lock();
        if (auto ec = m_condPop.wait(
                guard,
                [this]() noexcept { return m_items.empty() || cancelled(); },
                maxWait))
            return cancel(APERR(ec));

        if (setCompleted) complete();
    }

    // Resets the state of this queue
    auto reset(Opt<size_t> maxDepth = {}) noexcept {
        auto guard = lock();
        m_max = maxDepth.value_or(m_max);
        ASSERT(m_max != 0);
        m_items.clear();
        m_pushWaitCount = {};
        m_popWaitCount = {};
        m_cancelled.reset();
        m_completed = false;
    }

    // Returns the number of queue entries present
    auto size() const noexcept {
        auto guard = lock();
        return m_items.size();
    }

    bool empty() const noexcept {
        auto guard = lock();
        return m_items.empty();
    }

    // Cancels operations on this queue, any waiting thread will be
    // woken up with a cancellation error
    const Error &cancel(Opt<Error> reason = {}) const noexcept {
        auto guard = lock();

        if (!m_cancelled) {
            if (reason)
                m_cancelled.emplace(_mv(*reason));
            else
                m_cancelled.emplace(Ec::Cancelled, _location,
                                    "Queue cancelled");
        }

        // Always notify
        m_condPush.notifyAll(guard);
        m_condPop.notifyAll(guard);

        return *m_cancelled;
    }

    // Push an item onto the front of the back of the queue
    Error push(T &&item) noexcept {
        auto guard = lock();

        util::Guard countScope{[&] { m_pushWaitCount++; },
                               [&] { m_pushWaitCount--; }};

        if (auto ccode = completed())
            return APERR(Ec::Completed, "Queue completed");

        if (async::cancelled()) return async::cancelled(_location);

        if (auto ec = m_condPop.wait(guard, [this]() noexcept {
                return m_items.size() < m_max || cancelled();
            }))
            return APERR(ec, "Failed to wait on queue condition");

        m_items.emplace_back(_mv(item));
        m_condPush.notifyOne(guard);

        if (m_cancelled) return *m_cancelled;

        return {};
    }

    Error pushCopy(T item) noexcept { return push(_mv(item)); }

    // Attempts to pop an item off the queue if it is ready to go
    Opt<T> tryPop() noexcept {
        auto guard = lock();

        if (m_items.empty() || m_cancelled) return {};

        auto item = _mv(m_items.back());
        m_items.pop_back();
        m_condPop.notifyAll(guard);
        return item;
    }

    // Pop an item off the queue, will wait until an item is added
    // or if the thread was cancelled
    ErrorOr<T> pop(Opt<time::Duration> maxWait = {}) noexcept {
        auto guard = lock();

        util::Guard countScope{[this] { m_popWaitCount++; },
                               [this] { m_popWaitCount--; }};

        if (auto ec = m_condPush.wait(
                guard,
                [this]() noexcept {
                    return !m_items.empty() || m_cancelled || m_completed;
                },
                maxWait))
            return APERR(ec, "Condition wait");

        if (cancelled()) return *m_cancelled;

        if (m_items.empty()) {
            ASSERT(m_completed);
            return APERR(Ec::Completed, "Queue completed");
        }

        auto item = _mv(m_items.front());
        m_items.pop_front();
        m_condPop.notifyAll(guard);
        return item;
    }

    // Waits for all the threads to be waiting and the queue to be
    // empty. This is primarily used for ThreadedQueue
    Error waitForIdle(uint32_t threadCount) {
        // Returns true if the thread count is equal to the
        // number of threads passed in and the item count in the
        // queue is 0
        const auto isBusy = [this, &threadCount]() -> bool {
            auto guard = lock();

            // Get the number of waiting threads and items in the queue
            auto queuedItems = m_items.size();

            // Determine if we are busy
            if (m_popWaitCount != threadCount || queuedItems != 0)
                return true;
            else
                return false;
        };

        // Check the waiting thread count and the queue size
        while (isBusy()) {
            // Unlock/Sleep for 1/2 second/Lock
            if (auto ccode = async::sleepCheck(_location, .5s)) return ccode;
        }
        return {};
    }

    // Waits for the queue to become empty. Ensures that locking
    // the list during the check...
    Error waitForEmpty() {
        // Returns true if the queue is empty
        const auto isBusy = [this]() -> bool {
            auto guard = lock();

            // Get the number of waiting threads and items in the queue
            auto queuedItems = m_items.size();

            // Determine if we are busy
            if (queuedItems != 0)
                return true;
            else
                return false;
        };

        // Check the waiting thread count and the queue size
        while (isBusy()) {
            // Unlock/Sleep for 1/2 second/Lock
            if (auto ccode = async::sleepCheck(_location, .5s)) return ccode;
        }
        return {};
    }

    // Check if the queue, or the current thread are cancelled
    auto cancelled() const noexcept {
        auto guard = lock();

        if (async::cancelled() && !m_cancelled) {
            if (auto cancelled = async::cancelled(_location)) cancel(cancelled);
        }

        if (m_cancelled) return *m_cancelled;

        return Error{};
    }

    // Check if the queue was marked as completed, wakes up anyone waiting
    // on a pop
    auto completed() const noexcept {
        auto guard = lock();
        return m_completed;
    }

    // Mark the queue completed
    auto complete() noexcept {
        auto guard = lock();
        m_completed = true;
        m_condPush.notifyAll(guard);
    }

    // Range adapters, queue typically should be locked when using these,
    // but we do not assert on that as there are times where using
    // these directly is useful without holding the lock
    auto rbegin() const noexcept { return m_items.rbegin(); }
    auto rend() const noexcept { return m_items.rend(); }

    auto rbegin() noexcept { return m_items.rbegin(); }
    auto rend() noexcept { return m_items.rend(); }

    auto begin() const noexcept { return m_items.begin(); }
    auto end() const noexcept { return m_items.end(); }

    auto begin() noexcept { return m_items.begin(); }
    auto end() noexcept { return m_items.end(); }

    // Returns held ccode
    Opt<Error> &cancelCode() noexcept { return m_cancelled; }

    Condition &condPush() noexcept { return m_condPush; }

    Condition &condPop() noexcept { return m_condPop; }

    void stop() noexcept {
        cancel(APERR(Ec::Cancelled, "Queue cancelled"));
        flush();
    }

    size_t popWaitCount() const noexcept { return m_popWaitCount; }

    size_t pushWaitCount() const noexcept { return m_pushWaitCount; }

private:
    // This is where the items live
    std::deque<T> m_items;

    // Cancel reason code
    mutable Opt<Error> m_cancelled;

    // Number of pop waiters
    Atomic<size_t> m_popWaitCount = {};

    // Number of push waiters
    Atomic<size_t> m_pushWaitCount = {};

    // Completed flag, completion is an attribute that
    bool m_completed = false;

    // The main mutex protects our state with threading
    mutable MutexLock m_lock;

    // m_condPush - Add condition, one waiter awoken an item is added
    // m_condPop - Remove condition, all waiters awoken
    mutable Condition m_condPush, m_condPop;

    // Max number of items, when exceeded push will start blocking
    size_t m_max = {};
};

}  // namespace ap::async
