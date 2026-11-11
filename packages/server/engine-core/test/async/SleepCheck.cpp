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

#if ROCKETRIDE_PLAT_UNX
#include <time.h>

using namespace async;

namespace {

// CPU time this thread has used, in milliseconds
double threadCpuMs() noexcept {
    timespec ts{};
    ::clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts);
    return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

}  // namespace

TEST_CASE("async::sleepCheck") {
    SECTION("An idle wait sleeps instead of spinning") {
        // Waiters poll an idle queue with sleepCheck(.5s) in a loop, so the
        // CPU one call uses is paid for as long as the queue stays idle. A
        // yield spin over the first .1s of each call costs a fifth of a core.
        auto cpuBefore = threadCpuMs();
        auto start = time::now();
        for (int i = 0; i < 2; i++) REQUIRE(sleepCheck(.25s) == false);
        time::Duration elapsed = time::now() - start;
        auto cpuMs = threadCpuMs() - cpuBefore;

        REQUIRE(elapsed >= .5s);
        // Spinning costs about 100ms per call here, sleeping a few ms
        REQUIRE(cpuMs < 50);
    }
}
#endif
