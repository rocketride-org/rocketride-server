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

TEST_CASE("size::size") {
    SECTION("ToString") {
        REQUIRE(_ts(1_mb) == "1MB");
        REQUIRE(_ts(1_gb) == "1GB");
        REQUIRE(_ts(1.1_gb) == "1.1GB");
        REQUIRE(_ts(5123_mb) == "5GB");
        REQUIRE(_ts(Size::megabytes(5)) == "5MB");
        REQUIRE(_ts(5_mb) == "5MB");
        REQUIRE(Size::megabytes(5).toString(true) == "5MB (5,242,880)");
        REQUIRE(_ts(Size(126'029)) == "123.08kB");
        REQUIRE(_ts(10_mb) == "10MB");
        REQUIRE(_ts(2_kb) == "2kB");
        REQUIRE(_ts(3.1_tb) == "3.1TB");
        REQUIRE(_ts(4_gb) == "4GB");
        REQUIRE(_ts(5_b) == "5B");
    }

    SECTION("FromString") {
        REQUIRE(_fs<Size>("1mb") == 1_mb);
        REQUIRE(_fs<Size>("1gb") == 1_gb);
        REQUIRE(_fs<Size>("1.1gb") == 1.1_gb);
        REQUIRE(_fs<Size>("5123mb") == 5123_mb);
        REQUIRE(_fs<Size>("5MB (5,242,880)") == 5_mb);
        REQUIRE(_fs<Size>("5mb") == 5_mb);
        REQUIRE(_fs<Size>("10mb") == 10_mb);
        REQUIRE(_fs<Size>("2kb") == 2_kb);
        REQUIRE(_fs<Size>("3.1tb") == 3.1_tb);
        REQUIRE(_fs<Size>("4gb") == 4_gb);
        REQUIRE(_fs<Size>("5b") == 5_b);

        auto res = _fs<Size>("1,024mb");
        auto res2 = 1_gb;
        REQUIRE(res == 1_gb);
        REQUIRE(_fsh<Size>("0x400mb") == 1_gb);
        REQUIRE(_fsh<Size>("400mb") == 1_gb);
        REQUIRE(_fs<Size>("400mb") == 400_mb);
        REQUIRE(_fsh<Size>("48bf") == 0x48bf);
    }
}
