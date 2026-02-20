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

using TextPack = string::StrPack<TextChr, 1_mb>;

TEST_CASE("string::StrPack") {
    SECTION("basic") {
        TextPack pack;

        REQUIRE(pack.size() == 0);
        REQUIRE(pack.add("john") == "john");
        REQUIRE(pack.size() == 1);
        REQUIRE(pack.add("bobo") == "bobo");
        REQUIRE(pack.size() == 2);

        auto validate = [](auto &pack) {
            size_t index = 0;
            for (auto view = pack.first(); view; view = pack.next(view)) {
                switch (index++) {
                    case 0:
                        REQUIRE(view == "john");
                        break;
                    case 1:
                        REQUIRE(view == "bobo");
                        break;
                    default:
                        FAIL();
                }
            }
            REQUIRE(index == 2);
        };

        validate(pack);
    }
}
