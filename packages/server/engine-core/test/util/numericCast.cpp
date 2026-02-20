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
using namespace boost::numeric;

// Custom overflow handler that just records the result
struct TestOverflowHandler {
    inline static range_check_result lastRangeCheckResult = cInRange;

    void operator()(range_check_result r) noexcept { lastRangeCheckResult = r; }
};

// Return the cast value if no overflow occurred; otherwise, NullOpt
// (we don't care whether it was underflow or overflow)
template <typename To, typename From>
inline Opt<To> testNumericCast(From value) noexcept {
    auto res = ap::numericCast<To, From, TestOverflowHandler>(value);
    if (TestOverflowHandler::lastRangeCheckResult == cInRange) return res;
    return {};
}

TEST_CASE("util::numericCast") {
    REQUIRE(testNumericCast<int32_t>(100u) == 100);
    REQUIRE(testNumericCast<int32_t>(100ll) == 100);
    REQUIRE(testNumericCast<int32_t>(100ull) == 100);

    REQUIRE_FALSE(testNumericCast<uint32_t>(5967911418));
    REQUIRE_FALSE(testNumericCast<int32_t>(5967911418));
}