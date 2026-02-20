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

#include "test.h"

using namespace async;

// The test case is optional due to unstable failures on GitHub agents.
// Moreover, the parse filter synchronization should be refactored
// and class Event should be decommitted.
TEST_CASE("async::Event", "[.]") {
    SECTION("wait before set") {
        Event event;
        Thread thread(_location, "Thread", [&] {
            sleep(100ms);
            REQUIRE_NOTHROW(event.set());
        });

        REQUIRE_NOTHROW(thread.start());
        sleep(50ms);

        ErrorOr<bool> waitRes;
        REQUIRE_NOTHROW(waitRes = event.wait(0ms));
        REQUIRE(waitRes.hasValue());
        REQUIRE(!waitRes.value());

        sleep(100ms);

        REQUIRE_NOTHROW(waitRes = event.wait(0ms));
        REQUIRE(waitRes.hasValue());
        REQUIRE(waitRes.value());

        REQUIRE_NOTHROW(thread.join());
    }

    SECTION("wait after set") {
        Event event;
        Thread thread(_location, "Thread", [&] {
            sleep(50ms);
            REQUIRE_NOTHROW(event.set());
        });

        REQUIRE_NOTHROW(thread.start());
        sleep(100ms);

        ErrorOr<bool> waitRes;
        REQUIRE_NOTHROW(waitRes = event.wait(0ms));
        REQUIRE(waitRes.hasValue());
        REQUIRE(waitRes.value());

        REQUIRE_NOTHROW(thread.join());
    }

    SECTION("auto reset") {
        Event event;
        int counter = 0;
        Thread thread(_location, "Thread", [&] {
            REQUIRE_NOTHROW(event.wait());
            ++counter;

            REQUIRE_NOTHROW(event.wait());
            ++counter;
        });

        REQUIRE_NOTHROW(thread.start());
        sleep(100ms);
        REQUIRE(counter == 0);

        REQUIRE_NOTHROW(event.set());
        sleep(100ms);
        REQUIRE(counter == 1);

        REQUIRE_NOTHROW(event.set());
        sleep(100ms);
        REQUIRE(counter == 2);

        REQUIRE_NOTHROW(thread.join());
    }

    SECTION("manual reset") {
        Event event(true);
        int counter = 0;
        Thread thread(_location, "Thread", [&] {
            REQUIRE_NOTHROW(event.wait());
            ++counter;

            REQUIRE_NOTHROW(event.wait());
            ++counter;
        });

        REQUIRE_NOTHROW(thread.start());
        sleep(100ms);
        REQUIRE(counter == 0);

        REQUIRE_NOTHROW(event.set());
        sleep(100ms);
        REQUIRE(counter == 2);

        REQUIRE_NOTHROW(thread.join());

        REQUIRE_NOTHROW(thread.start());
        sleep(100ms);
        REQUIRE(counter == 4);

        REQUIRE_NOTHROW(thread.join());

        REQUIRE_NOTHROW(event.reset());

        REQUIRE_NOTHROW(thread.start());
        sleep(100ms);
        REQUIRE(counter == 4);

        REQUIRE_NOTHROW(event.set());
        sleep(100ms);
        REQUIRE(counter == 6);

        REQUIRE_NOTHROW(thread.join());
    }

    SECTION("waitAny") {
        Event event1;
        Thread thread1(_location, "Thread1", [&] {
            sleep(50ms);
            REQUIRE_NOTHROW(event1.set());
        });

        Event event2;
        Thread thread2(_location, "Thread2", [&] {
            sleep(100ms);
            REQUIRE_NOTHROW(event2.set());
        });

        SUBSECTION("Thread1 at pos 0") {
            REQUIRE_NOTHROW(thread1.start());
            REQUIRE_NOTHROW(thread2.start());

            auto waitOr = Event::waitAny({event1, event2});
            REQUIRE(waitOr.hasValue());
            auto value = waitOr.value();
            REQUIRE(value == 0);

            REQUIRE_NOTHROW(thread1.join());
            REQUIRE_NOTHROW(thread2.join());
        }

        REQUIRE_NOTHROW(event1.reset());
        REQUIRE_NOTHROW(event2.reset());

        SUBSECTION("Thread1 at pos 1") {
            REQUIRE_NOTHROW(thread1.start());
            REQUIRE_NOTHROW(thread2.start());

            auto waitOr = Event::waitAny({event2, event1});
            REQUIRE(waitOr.hasValue());
            auto value = waitOr.value();
            REQUIRE(value == 1);

            REQUIRE_NOTHROW(thread1.join());
            REQUIRE_NOTHROW(thread2.join());
        }
    }

    SECTION("waitAny 0 events") {
        auto waitRes = Event::waitAny({});
        REQUIRE(waitRes.hasCcode());
        REQUIRE(waitRes.ccode() == Ec::InvalidParam);
    }
}
