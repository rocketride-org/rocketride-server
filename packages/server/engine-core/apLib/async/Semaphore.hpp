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

#include <mutex>
#include <condition_variable>

#pragma once

namespace ap::async {
class Semaphore {
public:
    Semaphore(int count_ = 0) : m_count(count_) {}

    inline void notify() {
        std::unique_lock<std::mutex> lock(m_lock);
        m_count++;
        // notify the waiting thread
        m_condition.notify_one();
    }

    inline bool wait() {
        std::unique_lock<std::mutex> lock(m_lock);
        while (m_count == 0) {
            // wait on the mutex until notify is called
            m_condition.wait(lock);

            if (m_cancelled) return false;
        }
        m_count--;
        return true;
    }

    inline void complete() {
        std::unique_lock<std::mutex> lock(m_lock);

        m_cancelled = true;
        m_condition.notify_all();
    }

    inline void reset(int count_ = 0) {
        std::unique_lock<std::mutex> lock(m_lock);

        m_cancelled = false;
        m_count = count_;
    }

private:
    std::mutex m_lock;
    std::condition_variable m_condition;
    int m_count;
    bool m_cancelled = false;
};
}  // namespace ap::async