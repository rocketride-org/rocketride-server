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

TEST_CASE("url::Builder") {
    using namespace url;

    SECTION("NoAuthority") {
        Url url = builder()
                  << protocol("bobo:") << path("control/file.dat")
                  << parameter("keyId", 123) << parameter("appId", "bobo"_t);

        REQUIRE(_ts(url) == "bobo://control/file.dat?appId=bobo&keyId=123");
        REQUIRE(url.lookup("keyId") == "123");
        REQUIRE(url.template lookup<int>("keyId") == 123);
        REQUIRE(url.lookup("appId") == "bobo");
    }

    SECTION("WithAuthority") {
        Url url = builder()
                  << protocol("bobo:") << authority("10.1.1.2:5100")
                  << path("control/file.dat") << parameter("keyId", 123)
                  << parameter("appId", "bobo"_t);

        REQUIRE(_ts(url) ==
                "bobo://10.1.1.2:5100/control/file.dat?appId=bobo&keyId=123");
        REQUIRE(url.lookup("keyId") == "123");
        REQUIRE(url.template lookup<int>("keyId") == 123);
        REQUIRE(url.lookup("appId") == "bobo");
        REQUIRE(url.host() == "10.1.1.2");
        REQUIRE(url.port() == 5100);
    }

    SECTION("WithoutAuthority") {
        Url url = builder()
                  << protocolWithoutAuthority("bobo:") << path("10.1.1.2:5100")
                  << path("control/file.dat") << parameter("keyId", 123)
                  << parameter("appId", "bobo"_t);

        REQUIRE(_ts(url) ==
                "bobo://10.1.1.2:5100/control/file.dat?appId=bobo&keyId=123");
        REQUIRE(url.lookup("keyId") == "123");
        REQUIRE(url.template lookup<int>("keyId") == 123);
        REQUIRE(url.lookup("appId") == "bobo");
        REQUIRE(url.host() == "10.1.1.2");
        REQUIRE(url.port() == 5100);
    }

    SECTION("NoAuthorityNoSemiColon") {
        Url url = builder()
                  << protocol("bobo") << path("control/file.dat")
                  << parameter("keyId", 123) << parameter("appId", "bobo"_t);

        REQUIRE(_ts(url) == "bobo://control/file.dat?appId=bobo&keyId=123");
        REQUIRE(url.lookup("keyId") == "123");
        REQUIRE(url.template lookup<int>("keyId") == 123);
        REQUIRE(url.lookup("appId") == "bobo");
    }

    SECTION("WithAuthorityNoSemiColon") {
        Url url = builder()
                  << protocol("bobo") << authority("10.1.1.2:5100")
                  << path("control/file.dat") << parameter("keyId", 123)
                  << parameter("appId", "bobo"_t);

        REQUIRE(_ts(url) ==
                "bobo://10.1.1.2:5100/control/file.dat?appId=bobo&keyId=123");
        REQUIRE(url.lookup("keyId") == "123");
        REQUIRE(url.template lookup<int>("keyId") == 123);
        REQUIRE(url.lookup("appId") == "bobo");
    }

    SECTION("NoAuthorityRedundantSeps") {
        Url url = builder()
                  << protocol("bobo:") << path("//control/file.dat")
                  << parameter("keyId", 123) << parameter("appId", "bobo"_t);

        REQUIRE(_ts(url) == "bobo://control/file.dat?appId=bobo&keyId=123");
        REQUIRE(url.lookup("keyId") == "123");
        REQUIRE(url.template lookup<int>("keyId") == 123);
        REQUIRE(url.lookup("appId") == "bobo");
    }

    SECTION("WithAuthorityRedundantSeps") {
        Url url = builder()
                  << protocol("bobo:") << authority("10.1.1.2:5100")
                  << path("//control/file.dat/") << parameter("keyId", 123)
                  << parameter("appId", "bobo"_t);

        REQUIRE(_ts(url) ==
                "bobo://10.1.1.2:5100/control/file.dat?appId=bobo&keyId=123");
        REQUIRE(url.lookup("keyId") == "123");
        REQUIRE(url.template lookup<int>("keyId") == 123);
        REQUIRE(url.lookup("appId") == "bobo");
    }

    SECTION("NoAuthorityNoSemiColonRedundantSeps") {
        Url url = builder()
                  << protocol("bobo") << path("//control/file.dat/")
                  << parameter("keyId", 123) << parameter("appId", "bobo"_t);

        REQUIRE(_ts(url) == "bobo://control/file.dat?appId=bobo&keyId=123");
        REQUIRE(url.lookup("keyId") == "123");
        REQUIRE(url.template lookup<int>("keyId") == 123);
        REQUIRE(url.lookup("appId") == "bobo");
    }

    SECTION("WithAuthorityNoSemiColonRedundantSeps") {
        Url url = builder()
                  << protocol("bobo") << authority("10.1.1.2:5100")
                  << path("/control/file.dat/") << parameter("keyId", 123)
                  << parameter("appId", "bobo"_t);

        REQUIRE(_ts(url) ==
                "bobo://10.1.1.2:5100/control/file.dat?appId=bobo&keyId=123");
        REQUIRE(url.lookup("keyId") == "123");
        REQUIRE(url.template lookup<int>("keyId") == 123);
        REQUIRE(url.lookup("appId") == "bobo");
    }

    SECTION("End") {
        Url url = builder()
                  << protocol("bobo") << authority("10.1.1.2:5100")
                  << path("/control/file.dat/") << parameter("keyId", 123)
                  << parameter("appId", "bobo"_t) << end();

        REQUIRE(url.lookup("keyId") == "123");
        REQUIRE(_ts(url) ==
                "bobo://10.1.1.2:5100/control/file.dat?appId=bobo&keyId=123");
    }
}