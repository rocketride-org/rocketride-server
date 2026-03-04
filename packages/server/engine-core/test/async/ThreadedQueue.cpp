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

using namespace async;

TEST_CASE("async::ThreadedQueue") {
    ThreadedQueue<int> queue;

    SECTION("Queue dimenstions") {
        REQUIRE(queue.size() == 0);
        queue.push(99);
        REQUIRE(queue.size() == 1);
        auto value = queue.pop();
        REQUIRE(queue.size() == 0);
        REQUIRE(*value == 99);
    };

    SECTION("Queue threads") {
        Error ccode;

        const auto queueProcess = [&queue]() {
            Error ccode;
            while (true) {
                const auto value = queue.pop();
                if (value.hasCcode()) {
                    ccode = value.ccode();
                    break;
                }
                LOG(Test, "Threaded queue process value", value);
            }
            REQUIRE(ccode == Ec::Cancelled);
            return;
        };

        REQUIRE(queue.start(_location, "ThreadedQueue", 4, 32, queueProcess) ==
                Error{});
        for (int x = 0; x < 10; x++) {
            queue.push((int)x);
        }

        REQUIRE(queue.waitForEmpty() == Error{});
        queue.stop();

        // REQUIRE(queue.waitForIdle() == Error{});
        // REQUIRE(queue.flush() == Error{});
    }
}
