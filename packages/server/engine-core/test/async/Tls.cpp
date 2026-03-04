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

static auto g_constructed = 0;

struct MyObj {
    MyObj() noexcept { g_constructed++; }

    ~MyObj() noexcept { g_constructed--; }

    auto getStuff() const noexcept { return 5; }
};

static MyObj& myObj() noexcept {
    _thread_local Tls<MyObj> obj(_location);
    return *obj;
}

TEST_CASE("async::Tls") {
    SECTION("Basic") {
        auto thread = async::Thread{_location, "MyThread"};
        Atomic<bool> verified = {false};
        REQUIRE(myObj().getStuff() == 5);
        auto callback = [&]() noexcept {
            ASSERTD(myObj().getStuff() == 5);
            ASSERTD(g_constructed == 2);
            verified = true;
        };

        for (auto i = 0; i < 5; i++) {
            REQUIRE(!thread.start(callback));
            REQUIRE(!thread.join());
            REQUIRE(verified.exchange(false));
        }

        REQUIRE(g_constructed == 1);
    }

#ifdef ROCKETRIDE_PLAT_WIN
    SECTION("Com") {
        LOG(Test, "Spawning com initialized thread");

        async::Thread thr(_location, "Com+test",
                          [&] { return plat::ComInit::init(); });

        thr.start();
    }
#endif
}
