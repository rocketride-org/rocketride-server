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

TEST_CASE("async::Queue") {
    auto logScope = enableTestLogging(Lvl::Thread);

    async::Queue<int> queue;
    REQUIRE(queue.size() == 0);
    REQUIRE(!queue.cancelled());
    queue.push(5);
    REQUIRE(*queue.pop() == 5);
    queue.cancel();
    // ASSERT(!queue.pop() && queue.pop().ccode() == Ec::Cancelled);
    queue.cancel(Error{Ec::InvalidParam, _location, "Woops!"});
    // ASSERT(!queue.pop() && queue.pop().ccode() == Ec::InvalidParam);
    queue.reset();
    REQUIRE(queue.size() == 0);
    // ASSERT(!queue.pop(.1s) && queue.pop(.1s).ccode() == Ec::Timeout);
    queue.push(10);
    REQUIRE(queue.size() == 1);
    REQUIRE(*queue.pop(.1s) == 10);
    REQUIRE(queue.size() == 0);

    std::vector<int> poppedResults;

    auto waiterLoop = [&]() noexcept {
        _forever() {
            auto guard = queue.lock();
            auto res = queue.pop();
            if (!res) break;
            poppedResults.push_back(*res);
        }
    };

    std::vector<async::Thread> waiters;
    for (auto i = 0; i < 3; i++) {
        auto &thr =
            waiters.emplace_back(_location, _ts("Waiter #", i), waiterLoop);
        thr.start();
    }

    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.push(4);

    queue.flush();
    REQUIRE(queue.size() == 0);
    REQUIRE(poppedResults.size() == 4);
    REQUIRE(_anyOf(poppedResults, 1));
    REQUIRE(_anyOf(poppedResults, 2));
    REQUIRE(_anyOf(poppedResults, 3));
    REQUIRE(_anyOf(poppedResults, 4));
}
