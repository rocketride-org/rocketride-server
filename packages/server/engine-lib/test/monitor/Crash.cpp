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

// The server splits >CRASH as code*description*dump, the dump last
TEST_CASE("monitor::App::crashMessage") {
    using monitor::App;

    SECTION("no dump keeps an empty last field") {
        REQUIRE(
            App::crashMessage("11", "SIGSEGV: Invalid access to storage", "") ==
            "11*SIGSEGV: Invalid access to storage*");
    }

    SECTION("the dump is the last field") {
        REQUIRE(App::crashMessage("0xc0000005", "SEH exception 0xc0000005",
                                  "engine.mdmp") ==
                "0xc0000005*SEH exception 0xc0000005*engine.mdmp");
    }

    SECTION("a '*' in the description becomes a space") {
        REQUIRE(App::crashMessage("jvm", "a*b", "") == "jvm*a b*");
    }

    SECTION("an empty description keeps its field") {
        REQUIRE(App::crashMessage("6", "", "x.dmp") == "6**x.dmp");
    }
}
