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

// Lightweight interface only abstraction of std's condition_variable,
// adds support for automatic rewinding when used with our types
// such as MutexLock
class Condition final {
public:
    // Declare a detector alias for detecting whether the LockType
    // supports count tracking for recursion handling
    template <typename T>
    using TracksCount =
        traits::IsDetectedExact<int, traits::DetectCountMethod, T>;

    // Declare a detector alias for detecting whether the LockType
    // supports ownerId tracking
    template <typename T>
    using TracksOwnerId =
        traits::IsDetectedExact<Tid, traits::DetectOwnerIdMethod, T>;

    // Wait for a condition, specialize it to auto unwind our recursive
    // mutexes to a count of 1, allowing integration with the system condition
    // which _only_ ever unwinds one time.
    template <typename LockType, typename Predicate>
    ErrorCode wait(std::unique_lock<LockType> &guard, Predicate &&pred,
                   Opt<time::Duration> maxWait = {},
                   bool global = true) noexcept {
        bool timedOut = false;
        bool wasCancelled = false;

        // Wrap the callers predicate to include a cancellation check
        auto wrapper = [&]() noexcept {
            wasCancelled = cancelled(global) || m_cancelled;

            return wasCancelled || pred();
        };

        auto wait = [&]() noexcept {
            if (maxWait)
                timedOut =
                    !m_cond.wait_for(guard, maxWait->asMilliseconds(), wrapper);
            else
                m_cond.wait(guard, wrapper);
        };

        // If the lock type supports counting, rewind it before
        // entering the base condition wait api
        if constexpr (TracksCount<LockType>{}) {
            auto count = rewind(guard.mutex());
            wait();
            fastfwd(guard.mutex(), count);
        } else {
            wait();
        }

        if (timedOut) return std::make_error_code(Ec::Timeout);

        if (wasCancelled) return std::make_error_code(Ec::Cancelled);

        return std::make_error_code(Ec::NoErr);
    }

    // Notifies all waiters
    template <typename LockType>
    void notifyAll(std::unique_lock<LockType> &guard) noexcept {
        assertLocked(guard);
        m_cond.notify_all();
    }

    // Notifies one waiter
    template <typename LockType>
    void notifyOne(std::unique_lock<LockType> &guard) noexcept {
        assertLocked(guard);
        m_cond.notify_one();
    }

    template <typename LockType>
    void cancel(std::unique_lock<LockType> &guard) noexcept {
        m_cancelled = true;
        notifyAll(guard);
    }

    void reset() noexcept { m_cancelled = false; }

private:
    // Rewinds a lock by calling unlock on it for as many times as
    // is needed until the count is 1
    template <typename LockType>
    static size_t rewind(LockType *lock) noexcept {
        size_t unlockCount = 0;
        while (lock->count() != 1) {
            lock->unlock();
            unlockCount++;
        }
        return unlockCount;
    }

    // Plays back a lock count on a mutex
    template <typename LockType>
    static void fastfwd(LockType *lock, size_t count) noexcept {
        for (auto i = 0u; i < count; i++) lock->lock();
    }

    // Debug assert helper method
    template <typename LockType>
    static void assertLocked(std::unique_lock<LockType> &guard) noexcept {
        if constexpr (TracksOwnerId<LockType>{})
            ASSERT_MSG(
                guard.mutex() && guard.mutex()->ownerId() == threadId(),
                "Attempting to notify without hoilding the lock is racy");
        else
            ASSERT_MSG(
                guard.mutex(),
                "Attempting to notify without hoilding the lock is racy");
    }

    // Contextual cancellation of this condition
    bool m_cancelled = {};

    // Internal condition we forward wait requests to
    std::condition_variable_any m_cond;
};

}  // namespace ap::async
