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

namespace ap::async {

// Threaded queues provides a thread and a queue for an arbitrary number of
// threads, each queue is handed to each thread when they are started and
// the threads consume the queues input, while also stealing queue items
// from other threads if their queue runs dry
template <typename EntryT>
class ThreadedQueues {
public:
    _const auto LogLevel = Lvl::Buffer;

    using CallbackType = Function<void(Ref<async::Queue<EntryT>>)>;

    ~ThreadedQueues() noexcept {
        // First cancel the queues
        for (auto& queue : m_queues) queue.cancel();

        // Now stop the threads
        for (auto& thread : m_threads) thread.stop();

        // Clear memory
        for (auto& queue : m_queues) queue.reset();
    }

    // Starts the thread count requested, assigns each a queue
    Error start(Location location, TextView namePrefix, uint32_t threadCount,
                size_t queueDepth, CallbackType&& callback) noexcept {
        // Stop if we are already started
        stop();

        // If we bail early stop
        auto stopGuard = util::Guard{[&]() noexcept { stop(); }};

        // First setup the queues so we can hand the threads references to them
        for (unsigned i = 0; i < threadCount; i++) {
            auto& queue = m_queues.emplace_back(queueDepth);
            m_threads.emplace_back(location, _ts(namePrefix, "-", i), callback,
                                   queue);
        }

        // Now start them
        for (auto& thread : m_threads) {
            if (auto ccode = thread.start())
                return APERRT(ccode, "Failed to start thread for", namePrefix);
        }

        // Abort the fail safe
        stopGuard.cancel();
        return {};
    }

    // Force stops all the threads and deinits the queues
    void stop() noexcept {
        // Cancel each queue
        for (auto& queue : m_queues) queue.cancel();

        // Stop each thread
        for (auto& thread : m_threads) thread.stop();

        // Clear the queues
        for (auto& queue : m_queues) queue.reset();
    }

    // Waits for all the queues to empty, operates in two mode,
    // complete - Marks queue complete, joins on threads (complete will wake up
    // the threads) not complete - Just waits for queue count to drop to zero
    // then returns (threads will continue waiting)
    Error flush(bool complete = true) noexcept {
        // All done, now we need to flush the queue
        Error ccode;

        // First mark all the queues complete if requested, this is important as
        // we need all our queues to operate as one
        if (complete) {
            for (auto& queue : m_queues) queue.complete();
        }

        // Drain the queues next
        for (auto& queue : m_queues) ccode = queue.flush(false) || ccode;

        if (complete) {
            // If this is the end, join on the threads
            for (auto& thread : m_threads) {
                if (auto joinCode = thread.join())
                    ccode = APERRT(joinCode, "Failed to join on thread",
                                   thread.name()) ||
                            ccode;
            }
            m_threads.clear();

            for (auto& queue : m_queues) queue.reset();
            m_queues.clear();
        } else {
            // Not the end, wait until our pop count == the therad count, this
            // indicates the threads are doing no work (but we'll still wake up
            // if someone sets the global cancel flag ala sleepCheck)
            while (popWaitCount() != m_threads.size()) {
                for (auto&& thread : m_threads) {
                    if (thread.running()) continue;
                    return thread.join();
                }

                if (auto ccode = async::sleepCheck(_location, .5s))
                    return ccode;
            }
        }

        return ccode;
    }

    // Return the queue with the most pending entries
    auto& max() noexcept {
        ASSERTD_MSG(!m_queues.empty(), "Queues not started");

        Opt<Ref<async::Queue<EntryT>>> fullest{m_queues.front()};
        for (auto& q : m_queues) {
            if (q.size() > fullest->get().size()) fullest = q;
        }
        return fullest->get();
    }

    // Callers queue will be checked if its empty before we go looking for
    // another queue
    auto& max(async::Queue<EntryT>& check) noexcept {
        ASSERTD_MSG(!m_queues.empty(), "Queues not started");

        if (check.size()) return check;

        return max();
    }

    // Return the queue with the least pending entries
    auto& min() noexcept {
        ASSERTD_MSG(m_queues.empty() == false, "Queues not started");

        // Place the dir in the queue with the least number of entries
        Opt<Ref<async::Queue<EntryT>>> emptiest{m_queues.front()};
        for (auto& q : m_queues) {
            if (q.size() < emptiest->get().size()) emptiest = q;
        }
        return emptiest->get();
    }

    auto cancel(const Error& ccode) noexcept {
        for (auto queue : m_queues) queue.cancel(ccode);
        return ccode;
    }

    size_t pushWaitCount() const noexcept {
        size_t count = {};
        for (const auto& queue : m_queues) count += queue.pushWaitCount();
        return count;
    }

    size_t popWaitCount() const noexcept {
        size_t count = {};
        for (const auto& queue : m_queues) count += queue.popWaitCount();
        return count;
    }

    size_t size() const noexcept {
        size_t s = {};
        for (const auto& queue : m_queues) s += queue.size();
        return s;
    }

private:
    // Group of threads and their associated queues
    std::vector<async::Thread> m_threads;
    std::list<async::Queue<EntryT>> m_queues;
};

}  // namespace ap::async
