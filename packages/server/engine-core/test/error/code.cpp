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

TEST_CASE("ErrorCode") {
    SECTION("ap") {
        auto code = make_error_code(Ec::Cancelled);
        REQUIRE(code.message() == "Cancelled");
        REQUIRE(TextView{code.category().name()} == "ap");

        auto str = _ts(Error{code, _location, "Woops!"});
        LOG(Test, str);
    }

#if ROCKETRIDE_PLAT_WIN
    SECTION("win32") {
        auto code = make_error_code(ERROR_ACCESS_DENIED);
        REQUIRE(code.message() == "Access is denied");
        REQUIRE(TextView{code.category().name()} == "win32");
    }
#else
    SECTION("errno") {
        auto code = make_error_code(EINVAL);
        REQUIRE(code.message() == "Invalid argument");
        REQUIRE(TextView{code.category().name()} == "errno");
    }
#endif

    SECTION("macros") {
        auto code = APERR(Ec::InvalidParam, "Woops!", 1, 2, 3);
        REQUIRE(code.message() == "Woops! 1 2 3");
    }
}
