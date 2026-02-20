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

namespace ap::async::work {

// The work executor executes work objects, and re-uses a pool of threads
// for work execution
class Executor final {
public:
    // Declare the log level used by this class
    _const auto LogLevel = Lvl::WorkExec;

    Executor(Text name) noexcept;
    ~Executor() noexcept;

    ErrorOr<Item> submit(Location location, Text name, Callback &&cb) noexcept;
    void deinit() noexcept;
    Error init(uint32_t threadCount = 10,
               size_t maxTasks = MaxValue<size_t>) noexcept;
    auto flush(bool setCompleted = true) noexcept {
        return m_queue.flush(setCompleted);
    }

    // Locks this work executor, no new works will execute while this
    // lock is held
    // @returns
    // Lock guard to this work executor
    auto lock() const noexcept { return m_queue.lock(); }

private:
    void serviceLoop() noexcept;

    // Our logical name
    Text m_name;

    // Queue of work ptrs, the work threads all wait for queue entries
    // to appear here
    Queue<ItemCtxWPtr> m_queue;

    // Threads that execute works, managed as a group
    std::vector<Thread> m_threads;
};

}  // namespace ap::async::work
