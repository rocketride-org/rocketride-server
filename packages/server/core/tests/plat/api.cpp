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

TEST_CASE("plat::env") {
    _const auto key = "APLIB_TEST_VAR"_tv;
    // Use a new value each time to ensure we're not seeing some previous test's
    // settings
    const auto value = _ts(Uuid::create());
    plat::setEnv(key, value);
    REQUIRE(plat::env(key) == value);

    SECTION("Default value") {
        // Test querying randomly named environment variable with a default
        // value
        REQUIRE(plat::envOr(_ts(Uuid::create()), value) == value);
    }
}

TEST_CASE("plat::accountFromUsername") {
    REQUIRE(plat::accountFromUsername("domain\\user") == "user"_tv);
    REQUIRE(plat::accountFromUsername("user@domain.local") ==
            "user@domain.local"_tv);
}

TEST_CASE("plat::domainFromUsername") {
    REQUIRE(plat::domainFromUsername("domain\\user") == "domain"_tv);
    REQUIRE_FALSE(plat::domainFromUsername("user@domain.local"));
}