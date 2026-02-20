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

// Threaded queues provides a thread and a queue for an arbitrary number of
// threads, each queue is handed to each thread when they are started and
// the threads consume the queues input, while also stealing queue items
// from other threads if their queue runs dry
template <typename T>
class ThreadedQueue : public Queue<T> {
    using Parent = Queue<T>;

public:
    _const auto LogLevel = Lvl::Buffer;

    using CallbackType = Function<void()>;

    ThreadedQueue(size_t maxDepth = MaxValue<size_t>) : Parent(maxDepth) {};
    ~ThreadedQueue() noexcept {
        // Same as stop
        stop();
    }

    // Starts the thread count requested, assigns each a queue
    Error start(Location location, TextView namePrefix, uint32_t threadCount,
                size_t queueDepth, CallbackType &&callback) noexcept {
        // Stop if we are already started
        stop();

        // Set the new depth
        Parent::setDepth(queueDepth);

        // If we bail early stop
        auto stopGuard = util::Guard{[&]() noexcept { stop(); }};

        // Save this so we can wait for idle
        m_threadCount = threadCount;

        // Create the threads
        for (unsigned i = 0; i < threadCount; i++) {
            m_threads.emplace_back(location, _ts(namePrefix, "-", i), callback);
        }

        // Now start them
        for (auto &thread : m_threads) {
            if (auto ccode = thread.start())
                return APERRT(ccode, "Failed to start thread for", namePrefix);
        }

        // Abort the fail safe
        stopGuard.cancel();
        return {};
    }

    // Force stops all the threads and deinits the queues
    void stop() noexcept {
        // Cancel the queue
        Parent::cancel();

        // Stop each thread
        for (auto &thread : m_threads) thread.stop();

        // Clear the queue
        Parent::reset();
    }

    // Waits for all the queues to empty, operates in two modes:
    //
    // complete - Marks queue complete, joins on threads (complete
    // will wake up the threads)
    //
    // not complete - Just waits for queue count to drop to zero
    // then returns (threads will continue waiting)
    //
    Error flush(bool complete = true) noexcept {
        // All done, now we need to flush the queue
        Error ccode;

        // First mark all the queues complete if requested, this is important as
        // we need all our queues to operate as one
        if (complete) Parent::complete();

        // Drain the queues next
        ccode = Parent::flush(false);

        if (complete) {
            // If this is the end, join on the threads
            for (auto &thread : m_threads) {
                if (auto joinCode = thread.join())
                    ccode = APERRT(joinCode, "Failed to join on thread",
                                   thread.name()) ||
                            ccode;
            }

            // Clear the thread list
            m_threads.clear();

            // Reset the queue
            Parent::reset();
        } else {
            // Not the end, wait until our pop count == the thread count, this
            // indicates the threads are doing no work (but we'll still wake up
            // if someone sets the global cancel flag ala sleepCheck)
            while (Parent::popWaitCount() != m_threads.size()) {
                if (auto ccode = async::sleepCheck(_location, .5s))
                    return ccode;
            }
        }

        return ccode;
    }

    // Waits for all the threads to be waiting and the queue to be
    // empty
    Error waitForIdle() { return Parent::waitForIdle(m_threadCount); }

private:
    // Group of threads and their associated queues
    std::vector<async::Thread> m_threads;
    uint32_t m_threadCount;
};

}  // namespace ap::async
