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

// Result queue is an asynchronous lambda execution class
// which manages its own threads to execute the lambdas
// submitted to it. It ensures the results of the lambdas
// are returned in the same order of submissions.
template <typename ResultT>
class ResultQueue final {
public:
    // Define the types we will be using
    using CallbackType = std::function<ResultT()>;
    using CompletionCallbackType = std::function<void(ResultT &)>;
    using Mutex = std::mutex;
    using Guard = std::unique_lock<Mutex>;
    using Condition = std::condition_variable;

    // Disable move and assignment
    ResultQueue(const ResultQueue &) = delete;
    ResultQueue(ResultQueue &&) = delete;
    ResultQueue &operator=(const ResultQueue &) = delete;
    ResultQueue &operator=(ResultQueue &&) = delete;

    // Construct from a logical queue name
    ResultQueue(Text name) noexcept : m_name(_mv(name)) {}

    // Create a result queue with threads
    ResultQueue(Text name, size_t threadCount, size_t maxDepth = 100) noexcept
        : ResultQueue(_mv(name)) {
        start(threadCount, maxDepth);
    }

    // On destruction stop the threads
    ~ResultQueue() noexcept { stop(); }

    // Define our entry states
    // 	INIT 		- Initial state, not in index
    // 	PENDING 	- Submitted, present in index, waiting for service
    // 	ACTIVE 		- Actively being processed by a thread
    // 	COMPLETED 	- No completion handler present, entry completed
    // 				  result is set
    APUTIL_DEFINE_ENUM_C(State, 0, 5, INIT = _begin, PENDING, ACTIVE,
                         COMPLETED);

    // This structure is what encapsulates a item of work. It lives
    // in the entries container, threads wake up then race to grab
    // marked as State::PENDING, set its state to State::ACTIVE,
    // process the item, then set its State::COMPLETED.
    struct Entry {
        // Index of this entry in the entry vector
        size_t index;

        // State of this entry
        State state = State::INIT;

        // An atomically incremented value which is assigned on
        // submission of an entry. We use this field to ensure the
        // results are ordered based on submission order.
        Opt<size_t> orderId = {};

        // The callback which the caller defined for the work
        CallbackType callback;

        // Timing of how long it took to service, when it
        // was submitted, and how long it took to complete
        time::PreciseStamp submitTime, serviceTime, completedTime;

        // The held result of the callback
        Opt<ResultT> result;
    };

    // Submit a callback, will block if the queue depth
    // max has been reached
    auto submit(CallbackType &&callback) noexcept {
        // Wait for a free entry to use
        auto guard = lock();
        auto entry = waitEntryInit(guard);
        if (!entry) {
            // Means we're stopped, verify that assumption...
            ASSERTD(m_stop);
            return false;
        }

        // Populate the item and set its state to pending
        ASSERT(callback);
        entry->get().callback = _mv(callback);
        setState(entry->get(), State::PENDING);

        return true;
    }

    // Wait for a free entry to appear
    auto waitFree(time::Duration maxWait = {}) const noexcept {
        // Wait for a free entry to use
        auto guard = lock();
        auto pred = [&]() noexcept {
            if (m_stop) return true;

            for (auto &entry : m_entries) {
                if (entry.state == State::INIT) return true;
            }

            return false;
        };

        if (!m_cond.wait_for(guard, maxWait.asMilliseconds(), pred))
            return false;

        if (m_stop) return false;
        return true;
    }

    // Blocks until all active and pending work completes, or if
    // the optional max wait duration was met. If a result handler
    // is specified, it will also wait for items, this version
    // will only wait for the given duration, and returns false if
    // it times out.
    auto flush(Opt<time::Duration> maxWait = {}) const noexcept {
        auto guard = lock();
        auto pred = [&]() noexcept {
            if (m_completionHandler)
                return countIndexState({State::PENDING, State::ACTIVE,
                                        State::COMPLETED}) == 0 ||
                       m_stop;
            else
                return countIndexState({State::PENDING, State::ACTIVE}) == 0 ||
                       m_stop;
        };

        if (maxWait) {
            if (!m_cond.wait_for(guard, maxWait->asMilliseconds(), pred))
                return false;
        }
        m_cond.wait(guard, pred);
        return true;
    }

    // Sets the stop flag, signals the condition, does not block
    void cancel() noexcept {
        m_stop = true;
        m_cond.notify_all();

        // Avoid a lock here so sleep a bit then raise the condition
        // again, should get the threads to notice
        std::this_thread::yield();
        m_cond.notify_all();
    }

    // Fetches the result of the complete items, blocks until all
    // submitted items finish
    std::vector<ResultT> results(bool flushFirst = true) noexcept {
        if (flushFirst) flush();

        // Grab whatever results are available now
        auto guard = lock();
        if (m_stop) return {};

        // Remove all completed items from the index and collect their
        // results in order
        std::vector<ResultT> results;
        results.reserve(m_entries.size());
        while (!m_index.empty()) {
            auto &[orderId, entryIndex] = *m_index.begin();
            auto &entry = m_entries[entryIndex];

            // Stop to ensure results are in order on the first
            // uncompleted entry
            if (entry.state != State::COMPLETED) break;

            results.push_back(_mv(*entry.result));

            // Set entry state to init and loop
            setState(entry, State::INIT);
        }

        return results;
    }

    // Wait for results for a given max duration
    std::vector<ResultT> waitResults(time::Duration maxWait) noexcept {
        if (!flush(maxWait)) return {};
        return results(false);
    }

    // Starts the queue
    Error start(size_t threadCount, size_t maxDepth = 100,
                Opt<CompletionCallbackType> completionHandler = {}) noexcept {
        // Make sure we're stopped
        stop();

        // Pre-reserve our flat index and entry max size
        m_completionHandler = _mv(completionHandler);
        m_entries.reserve(maxDepth);
        m_index.container.reserve(maxDepth);

        // Establish the entry indicies
        for (size_t i = 0; i < maxDepth; i++) m_entries.push_back({i});

        m_stop = false;

        // Add the requested set of threads
        m_threads.reserve(threadCount);
        for (auto i = 0; i < threadCount; i++)
            m_threads.emplace_back(_location, _ts(m_name, " thread #", i),
                                   std::bind(&ResultQueue::service, this));

        // And start em
        m_threads.reserve(threadCount);
        for (auto &thread : m_threads) {
            if (auto ccode = thread.start()) {
                stop();
                return ccode;
            }
        }

        return {};
    }

    // Stops all active threads
    auto stop(bool flushFirst = false) noexcept {
        // Do graceful flush if requested first
        if (flushFirst) flush();

        // Signal under the lock
        auto guard = lock();
        m_stop = true;
        m_cond.notify_all();
        guard = {};

        // Join on each thread (std::thread won't self join on destruction)
        util::removeEach(m_threads, [&](auto &thread) { thread.join(); });

        // And reset state
        m_entries.clear();
        m_index.clear();
    }

    // Returns the number of pending items, pending items are items
    // which have not been grabbed by a thread yet
    size_t pending() const noexcept {
        auto guard = lock();
        return countIndexState({State::PENDING});
    }

    // Returns the number of active items, active items are ones
    // which are actively being processed by a thread
    size_t active() const noexcept {
        auto guard = lock();
        return countIndexState({State::ACTIVE});
    }

    // Returns the number of completed items, completed items are
    // entries which have been serviced and hold a result
    size_t completed() const noexcept {
        auto guard = lock();
        return countIndexState({State::COMPLETED});
    }

    // Returns the sum of pending + active + completed
    size_t total() const noexcept {
        auto guard = lock();
        return countIndexState(
            {State::PENDING, State::ACTIVE, State::COMPLETED});
    }

    // Boolean operator returns true if something is going on in the
    // queue
    explicit operator bool() const noexcept { return total(); }

    // Returns the value of the stop flag
    bool stopped() const noexcept { return m_stop; }

    // Renders the queue counts
    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        // Do this unlocked, shouldn't be an issue since we do not
        // resize the entry array
        return string::formatBuffer(buff, "{} {}{}-{}-{}", m_name,
                                    m_stop ? "(Cancelled)" : "",
                                    Count(countIndexState({State::PENDING})),
                                    Count(countIndexState({State::ACTIVE})),
                                    Count(countIndexState({State::COMPLETED})));
    }

private:
    // Counts the entries with a matching state value
    auto countIndexState(InitList<State> states) const noexcept {
        return util::countIf(
            m_index, [&](const auto &orderid, const auto &index) noexcept {
                return util::anyOf(states, m_entries[index].state);
            });
    }

    // Waits for an available initialized entry entry to populate
    // during a submit
    Opt<Ref<Entry>> waitEntryInit(Guard &guard,
                                  Opt<time::Duration> maxWait = {}) noexcept {
        Opt<Ref<Entry>> result;

        auto pred = [&]() noexcept {
            if (m_stop) return true;

            for (auto &entry : m_entries) {
                if (entry.state == State::INIT) {
                    result = entry;
                    return true;
                }
            }

            return false;
        };

        if (m_stop) return {};

        if (maxWait)
            m_cond.wait_for(guard, maxWait->asMilliseconds(), pred);
        else
            m_cond.wait(guard, pred);

        if (m_stop) return {};

        return result;
    }

    // Waits for an indexed entry state, returns the found entry state
    Opt<Ref<Entry>> waitIndexState(Guard &guard,
                                   InitList<State> states) noexcept {
        Opt<Ref<Entry>> result;
        m_cond.wait(guard, [&]() noexcept {
            if (m_stop) return true;

            for (auto &[orderId, entryIndex] : m_index) {
                auto &entry = m_entries[entryIndex];
                if (util::anyOf(states, entry.state)) {
                    result = entry;
                    return true;
                }
            }

            return false;
        });

        if (m_stop) return {};

        return result;
    }

    // Services entries, called by each thread we
    // start
    void service() noexcept {
        while (!m_stop) {
            // Be nice, don't spin hard here
            std::this_thread::yield();

            // Wait for pending or stop
            auto guard = lock();
            Opt<Ref<Entry>> entry;
            if (m_completionHandler)
                entry =
                    waitIndexState(guard, {State::PENDING, State::COMPLETED});
            else
                entry = waitIndexState(guard, {State::PENDING});

            // Exit if stopped
            if (m_stop) break;

            // If we didn't get an entry, wait again
            if (!entry) continue;

            // On the pending case, service it
            if (entry->get().state == State::PENDING) {
                // Set active state, this will set serviceTime
                setState(entry->get(), State::ACTIVE);

                // Unlock while we call the handler
                guard = {};
                entry->get().result = entry->get().callback();
                guard = lock();

                // This entry is now completed
                setState(entry->get(), State::COMPLETED);
            }

            // Completed case

            // If a completion handler is defined start processing
            // completed entries if we can atomically grab the completion
            // lock first
            if (m_completionHandler && !m_completionFlag.exchange(true)) {
                // While the top of the index has a completed entry
                // forward it to the completion handler then clear it.
                // The moment we encounter a non completed one stop to
                // maintain result ordering.
                while (!m_index.empty()) {
                    entry = m_entries[m_index.begin()->second];
                    if (entry->get().state == State::COMPLETED) {
                        guard = {};
                        m_completionHandler->operator()(*entry->get().result);
                        guard = lock();
                        setState(entry->get(), State::INIT);
                        continue;
                    }
                    break;
                }

                m_completionFlag = false;
            }
        }
    }

    // Sets state on an entry, raises the condition as needed
    // handles setting the times in the entry based on the state
    void setState(Entry &entry, State state) noexcept {
        switch (state) {
            // Entry is being cleared, remove from index, clear all
            // fields
            case State::INIT:
                if (entry.orderId) {
                    ASSERT(m_index.find(*entry.orderId)->second == entry.index);
                    m_index.erase(*entry.orderId);
                    ASSERT(m_index.find(*entry.orderId) == m_index.end());
                }
                entry.callback = {};
                entry.orderId = {};
                entry.state = State::INIT;
                break;

            // Entry is waiting for service, validate previous state
            // is INIT, allocate an order id for it, set
            // submitTime to now, and add to index
            case State::PENDING:
                ASSERT(!entry.orderId);
                ASSERT(entry.state == State::INIT);
                entry.state = state;
                entry.submitTime = time::now();
                entry.orderId = m_nextOrderId++;
                ASSERT(m_index.find(*entry.orderId) == m_index.end());
                m_index[*entry.orderId] = entry.index;
                ASSERT(m_index.find(*entry.orderId)->second == entry.index);
                break;

            // Entry is going active, validate we are at pending state
            // mark service time to now and add to the index
            case State::ACTIVE:
                ASSERT(entry.state == State::PENDING);
                ASSERT(m_index.find(*entry.orderId)->second == entry.index);
                entry.serviceTime = time::now();
                entry.state = state;
                break;

            // Entry was serviced by a thread, leave in index, verify
            // previous state was active, set completedTime to now
            case State::COMPLETED:
                ASSERT(entry.state == State::ACTIVE);
                ASSERT(m_index.find(*entry.orderId)->second == entry.index);
                entry.completedTime = time::now();
                entry.callback = {};
                entry.state = state;
                break;

            default:
                ASSERTD(!"Unexpected queue state");
                break;
        }

        // An entries state has changed, raise our condition
        m_cond.notify_all();
    }

    // Locates an entry by its state
    Opt<Ref<Entry>> locate(State state) noexcept {
        auto iter = util::findIf(m_entries, [&](const auto &entry) noexcept {
            return entry.state == state;
        });

        if (iter == m_entries.end()) return {};

        return *iter;
    }

    // Allocates a lock guard on the mutex
    Guard lock() const noexcept { return Guard{m_mutex}; }

    // Where the threads live
    std::vector<Thread> m_threads;

    // A flat map of order ids pointing to entry indexes in the
    // entry vector
    FlatMap<size_t, size_t> m_index;

    // How we synchronize access to our state between threads
    mutable Mutex m_mutex;

    // One condition, raised when state changes on any entry
    mutable std::condition_variable_any m_cond;

    // List of entries, never resized, size set to queue depth,
    // never resized during use
    std::vector<Entry> m_entries;

    // Optional completion handler that will forward in order
    // completed results
    Opt<CompletionCallbackType> m_completionHandler;

    // Atomic flag that is set to true for the first thread
    // that grants it exclusive access to forward completed
    // items to the completion handler
    std::atomic_bool m_completionFlag = {};

    // Name of this queue
    Text m_name;

    // The order id is used to assign an order to each entry
    size_t m_nextOrderId = 1;

    // Stop flag gets set when stop is called, notifies the threads
    // that they should stop processing and die
    std::atomic_bool m_stop = {};
};

}  // namespace ap::async
