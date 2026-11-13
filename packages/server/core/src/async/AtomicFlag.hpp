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

// A spin mutex is a lightweight user mode lock using atomics to spin during the
// lock aquisition period. It is useful when you need to protect things
// that do not have a lot of contention without requiring a more heavy
// weight sychronization primitive such as a mutex.
template <size_t InitialSpin = 10>
class AtomicFlag {
public:
    // Locks this spin lock
    void lock() noexcept {
        // Spin hard for as much as the callers pre spin amount says to
        if constexpr (InitialSpin > 0) {
            for (size_t i = 0; i < InitialSpin; i++) {
                if (!m_flag.test_and_set(std::memory_order_acquire)) return;
            }
        }

        // We've spun beyond the pre spin amount, now switch to a larger
        // yield spin algorithm
        auto start = time::now();
        _forever() {
            if (!m_flag.test_and_set(std::memory_order_acquire)) return;

            auto totalWaited = time::now() - start;

            if (totalWaited > 5s)
                sleep(100ms);
            else if (totalWaited > 1s)
                sleep(50ms);
            else if (totalWaited > .5s)
                sleep(5ms);
            else if (totalWaited > .1s)
                sleep(1ms);
            else
                yield();
        }
    }

    // Unlocks this spin lock
    void unlock() noexcept { m_flag.clear(); }

protected:
    // This atomic flag is the lock indicator
    std::atomic_flag m_flag = {};
};

}  // namespace ap::async
