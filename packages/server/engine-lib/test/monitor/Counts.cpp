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

TEST_CASE("monitor::counts") {
    monitor::Counts counts, totals;

    auto verifyZero = [](const auto &c) {
        REQUIRE(c.total().count == 0);
        REQUIRE(c.total().size == 0);
        REQUIRE(c.completed().count == 0);
        REQUIRE(c.completed().size == 0);
        REQUIRE(c.failed().count == 0);
        REQUIRE(c.failed().size == 0);
    };

    verifyZero(counts);
    verifyZero(totals);

    counts.addCompleted(1'000, 10_mb);

    totals += counts;
    REQUIRE(totals.total().count == 1'000);
    REQUIRE(totals.total().size == 10_mb);
    REQUIRE(totals.completed().count == 1'000);
    REQUIRE(totals.completed().size == 10_mb);
    REQUIRE(totals.failed().count == 0);
    REQUIRE(totals.failed().size == 0);

    counts.reset();
    verifyZero(counts);

    counts.addCompleted(2'000, 5_mb);
    counts.addFailed(500, 1_mb);

    totals += counts;
    REQUIRE(totals.total().count == 3'500);
    REQUIRE(totals.total().size == 16_mb);
    REQUIRE(totals.completed().count == 3'000);
    REQUIRE(totals.completed().size == 15_mb);
    REQUIRE(totals.failed().count == 500);
    REQUIRE(totals.failed().size == 1_mb);

    counts.reset();
    verifyZero(counts);
}
