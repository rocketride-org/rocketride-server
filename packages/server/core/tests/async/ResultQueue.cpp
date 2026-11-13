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

#include "test.h"

TEST_CASE("async::ResultQueue") {
    SECTION(
        "ResultQueue returns results in order of submission with start/stop") {
        async::ResultQueue<int> queue("TestQueue", 1);
        for (auto i = 0; i < 10; i++) {
            LOG(Test, "Submitting waiter", i);
            queue.submit([i] {
                LOG(Test, "Waiter {} waiting for {}", i,
                    time::microseconds(10 - i));
                async::sleep(time::microseconds(10 - i));
                LOG(Test, "Waiter {} completed", i);
                return i;
            });
        }

        int expectedIndex = 0;
        LOG(Test, "Waiting on results");
        for (auto completedIndex : queue.results())
            REQUIRE(completedIndex == expectedIndex++);
        queue.stop();
    }

    SECTION(
        "ResultQueue returns results in order of submission with constructed "
        "start") {
        async::ResultQueue<int> queue("TestQueue", 3);
        for (auto i = 0; i < 10; i++) {
            LOG(Test, "Submitting waiter", i);
            queue.submit([i] {
                LOG(Test, "Waiter {} waiting for {}", i,
                    time::microseconds(10 - i));
                async::sleep(time::microseconds(10 - i));
                LOG(Test, "Waiter {} completed", i);
                return i;
            });
        }

        int expectedIndex = 0;
        queue.flush();
        auto results = queue.results();
        LOG(Test, "Results: {}", results);
        for (auto completedIndex : results)
            REQUIRE(completedIndex == expectedIndex++);
    }
}
