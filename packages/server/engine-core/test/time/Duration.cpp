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

using namespace time;

TEST_CASE("time::Duration") {
    SECTION("To string") {
        REQUIRE(_ts(1s) == "1s");
        REQUIRE(_ts(1.1s) == "1.1s");
        REQUIRE(_ts(1.5h) == "1.5h");
        REQUIRE(_ts(90min) == "1.5h");
        REQUIRE(_ts(1000.5h) == "5.96w");
        REQUIRE(_ts(10h + 1h) == "11h");
        REQUIRE(_ts(2.2ms) == "2.2ms");

        REQUIRE(_ts(-1s) == "-1s");
        REQUIRE(_ts(-1.1s) == "-1.1s");
        REQUIRE(_ts(-1.5h) == "-1.5h");
        REQUIRE(_ts(-90min) == "-1.5h");
        REQUIRE(_ts(-1000.5h) == "-5.96w");
        REQUIRE(_ts(-10h + -1h) == "-11h");
        REQUIRE(_ts(-2.2ms) == "-2.2ms");
    }

    SECTION("From string") {
        REQUIRE(_fs<Duration>("1") == 1s);
        REQUIRE(_fs<Duration>("10") == 10s);
        REQUIRE(_fs<Duration>("1s") == 1s);
        REQUIRE(_fs<Duration>("1.1s") == 1.1s);
        REQUIRE(_fs<Duration>("1.5h") == 1.5h);
        REQUIRE(_fs<Duration>("1.5h") == 90min);

        // Handle floating point precision by checking a range for these
        REQUIRE(util::inRangeInclusive<Duration>(
            -1000.6h, _fs<Duration>("-41.69d"), -1000h));
        REQUIRE(util::inRangeInclusive<Duration>(1000h, _fs<Duration>("41.69d"),
                                                 1000.6h));
        REQUIRE(util::inRangeInclusive<Duration>(2.1ms, _fs<Duration>("2.2ms"),
                                                 2.3ms));

        REQUIRE(_fs<Duration>("-1s") == -1s);
        REQUIRE(_fs<Duration>("-1.1s") == -1.1s);
        REQUIRE(_fs<Duration>("-1.5h") == -1.5h);
        REQUIRE(_fs<Duration>("-1.5h") == -90min);
    }
}
