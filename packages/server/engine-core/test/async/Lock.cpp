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

TEST_CASE("async::Lock") {
    SECTION("std::mutex") {
        Lock<std::mutex> lock;
        auto guard = lock.acquire();
        guard = {};

        SECTION("condition") {
            Condition cond;
            guard = lock.acquire();
            cond.wait(guard, [&] { return true; });
        }
    }

    SECTION("MutexLock") {
        MutexLock lock;
        REQUIRE(lock.count() == 0);
        REQUIRE(lock.ownedByMe() == false);
        REQUIRE(lock.ownerId() == Tid{});
        auto guard = lock.acquire();
        REQUIRE(lock.count() == 1);
        REQUIRE(lock.ownedByMe() == true);
        REQUIRE(lock.ownerId() == threadId());
        auto guard2 = lock.acquire();
        REQUIRE(lock.count() == 2);
        REQUIRE(lock.ownedByMe() == true);
        REQUIRE(lock.ownerId() == threadId());
        guard2 = {};
        REQUIRE(lock.count() == 1);
        REQUIRE(lock.ownedByMe() == true);
        REQUIRE(lock.ownerId() == threadId());
        guard = {};
        REQUIRE(lock.count() == 0);
        REQUIRE(lock.ownedByMe() == false);

        SECTION("condition") {
            Condition cond;
            guard = lock.acquire();
            cond.wait(guard, [&] { return true; });
        }
    }

    SECTION("SpinLock") {
        SpinLock lock;
        REQUIRE(lock.ownedByMe() == false);
        REQUIRE(lock.ownerId() == Tid{});
        auto guard = lock.acquire();
        REQUIRE(lock.ownedByMe() == true);
        REQUIRE(lock.ownerId() == threadId());
        guard = {};
        REQUIRE(lock.ownedByMe() == false);

        SECTION("condition") {
            Condition cond;
            guard = lock.acquire();
            cond.wait(guard, [&] { return true; });
        }
    }

    SECTION("coalesce") {
        MutexLock lock1;
        MutexLock lock2{lock1};

        REQUIRE(lock1.ownedByMe() == false);
        REQUIRE(lock1.ownerId() == Tid{});
        REQUIRE(lock2.ownedByMe() == false);
        REQUIRE(lock2.ownerId() == Tid{});
        auto guard = lock1.acquire();
        REQUIRE(lock1.ownedByMe() == true);
        REQUIRE(lock1.ownerId() == threadId());
        REQUIRE(lock2.ownedByMe() == true);
        REQUIRE(lock2.ownerId() == threadId());
        guard = {};
        REQUIRE(lock1.ownedByMe() == false);
        REQUIRE(lock2.ownedByMe() == false);
    }
}
