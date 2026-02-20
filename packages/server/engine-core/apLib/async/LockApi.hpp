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

// A lock is a thing that has lock/unlock apis, with the guarantee
// that a lock is exclusive guard against with atomic aquisition semantics.
// This class wraps the lock type with ownerId support as well as lock
// count tracking.
template <typename T>
class LockApi : public T {
public:
    // Locks this mutex lock
    void lock() noexcept {
        T::lock();
        if (!m_count++) {
            ASSERT(!m_ownerId);
            m_ownerId = threadId();
        }
    }

    // Unlocks this mutex lock
    void unlock() noexcept {
        if (!--m_count) {
            ASSERT(m_ownerId == threadId());
            m_ownerId.reset();
        }
        T::unlock();
    }

    // Returns the current owner id (thread id)
    // @returns
    // The thread id owning the lock
    auto ownerId() const noexcept { return m_ownerId.value_or(Tid{}); }

    // Returns the lock count
    // @returns
    // Lock count held by current thread
    auto count() const noexcept { return m_count; }

protected:
    // Counter for lock recursion (signed for performance)
    int m_count = 0;

    // Current thread that last acquired this lock
    Opt<Tid> m_ownerId;
};

}  // namespace ap::async
