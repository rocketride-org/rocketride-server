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

TEST_CASE("timespec conversions") {
    using namespace ap::time;

    // Verify lossless conversion between timespec and Duration
    _using(const Duration duration{date::days{7}}) {
        auto ts = _tr<timespec>(duration);
        auto compare = _tr<Duration>(ts);
        REQUIRE(compare == duration);
        REQUIRE(_tr<Duration>(ts) == duration);
    }

    auto requireEquals = [](const timespec &lh, const timespec &rh) {
        REQUIRE(lh.tv_sec == rh.tv_sec);
        REQUIRE(lh.tv_nsec == rh.tv_nsec);
    };

    // Verify lossless conversion between timespec and SystemStamp
    _using(const auto now = nowSystem()) {
        auto ts = _tr<timespec>(now);
        auto stamp = _tr<SystemStamp>(ts);
        REQUIRE(stamp == now);
        auto ts2 = _tr<timespec>(stamp);
        requireEquals(ts, ts2);
    }

    // Verify lossless conversion between timespec and PreciseStamp
    _using(const auto now = nowPrecise()) {
        auto ts = _tr<timespec>(now);
        auto stamp = _tr<PreciseStamp>(ts);
        REQUIRE(stamp == now);
        auto ts2 = _tr<timespec>(stamp);
        requireEquals(ts, ts2);
    }
}

TEST_CASE("timeval conversions") {
    using namespace ap::time;

    // Verify lossless conversion between timeval and Duration
    _using(const Duration duration{date::days{7}}) {
        auto tv = _tr<timeval>(duration);
        auto compare = _tr<Duration>(tv);
        REQUIRE(compare == duration);
        REQUIRE(_tr<Duration>(tv) == duration);
    }

    auto requireEquals = [](const timeval &lh, const timeval &rh) {
        REQUIRE(lh.tv_sec == rh.tv_sec);
        REQUIRE(lh.tv_usec == rh.tv_usec);
    };

    // Verify lossless conversion between timeval and SystemStamp
    _using(const auto now = nowSystem()) {
        auto tv = _tr<timeval>(now);
        auto stamp = _tr<SystemStamp>(tv);
        REQUIRE(stamp == now);
        auto tv2 = _tr<timeval>(stamp);
        requireEquals(tv, tv2);
    }

    // Verify lossy conversion between timeval, which has a resolution of
    // microseconds, and PreciseStamp
    _using(const auto now = nowPrecise()) {
        auto tv = _tr<timeval>(now);
        auto stamp = _tr<PreciseStamp>(tv);
        auto tv2 = _tr<timeval>(stamp);
        requireEquals(tv, tv2);
    }
}