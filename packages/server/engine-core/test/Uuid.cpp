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

TEST_CASE("Uuid testing") {
    SECTION("Construct empty") {
        Uuid uuid;
        REQUIRE(!uuid);
        REQUIRE_FALSE(_ts(uuid));
    }

    SECTION("Construct") {
        auto uuid = Uuid::create();
        REQUIRE(uuid);
        REQUIRE(_ts(uuid));
        REQUIRE(uuid != Uuid::create());
    }

    SECTION("To string") {
        auto str = _ts(Uuid::create());
        REQUIRE(str.count("-"_tv) == 4);
    }

    SECTION("From string") {
        auto uuid = _fs<Uuid>("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
        REQUIRE(uuid);
        REQUIRE(
            _ts(uuid).equals("6ba7b810-9dad-11d1-80b4-00c04fd430c8", false));
    }
}
