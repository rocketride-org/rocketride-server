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

TEST_CASE("Glob match tests") {
    SECTION("Regex reference test") {
        Text expr = "john";
        auto regex = std::regex(expr, std::regex::icase | std::regex::nosubs);
        auto matched = std::regex_match("john", regex);
        REQUIRE(matched);
    }

    SECTION("Path delimiter threshold check") {
        auto glob = globber::Glob("C:/ProgramData/rocketride/agent/control", 0);
        REQUIRE(glob.valid());
        REQUIRE(
            glob.matches("C:/ProgramData/rocketride/agent/control/Appl "
                         "f635cc3f-appl-4622-8abe-a9e71270035f/Node "
                         "555b4a2c-agnt-46f1-bfa5-c6ac9653b393"));
        REQUIRE(
            !glob.matches("C:/ProgramData/rocketride/agent/control1/Appl "
                          "f635cc3f-appl-4622-8abe-a9e71270035f/Node "
                          "555b4a2c-agnt-46f1-bfa5-c6ac9653b393"));
    }

    SECTION("Wild single trailing range") {
        auto glob = globber::Glob("*[s]", 0);
        REQUIRE(glob.valid());
        REQUIRE(glob.matches("js"));
        REQUIRE(!glob.matches("ja"));
    }

    SECTION("Range wild any interleaved") {
        auto glob = globber::Glob("[w]*[w]*[w]*[s]", 0);
        REQUIRE(glob.valid());
        REQUIRE(!glob.matches("wjwaw"));
        REQUIRE(glob.matches("wjwaws"));
        REQUIRE(glob.matches("wjwawzs"));
    }

    SECTION("Exact match") {
        auto glob = globber::Glob("john", 0);
        REQUIRE(glob.valid());
        REQUIRE(glob.matches("john"));
    }

    SECTION("Negated set match") {
        auto glob = globber::Glob("[^john]", 0);
        REQUIRE(glob.valid());
        REQUIRE(!glob.matches("j"));
        REQUIRE(!glob.matches("o"));
        REQUIRE(!glob.matches("h"));
        REQUIRE(!glob.matches("n"));
        REQUIRE(!glob.matches("john"));
        REQUIRE(glob.matches("z"));
        REQUIRE(!glob.matches("za"));
        REQUIRE(glob.matches(" "));
        REQUIRE(!glob.matches(" z "));
    }

    SECTION("Negated range match") {
        auto glob = globber::Glob("[^a-d]", 0);
        REQUIRE(glob.valid());
        REQUIRE(!glob.matches("a"));
        REQUIRE(!glob.matches("b"));
        REQUIRE(!glob.matches("c"));
        REQUIRE(!glob.matches("d"));
        REQUIRE(!glob.matches("abcd"));
        REQUIRE(glob.matches("z"));
        REQUIRE(glob.matches("1"));
        REQUIRE(glob.matches("e"));
    }

    SECTION("Set match") {
        auto glob = globber::Glob("[john]", 0);
        REQUIRE(glob.valid());
        REQUIRE(glob.matches("j"));
        REQUIRE(glob.matches("o"));
        REQUIRE(glob.matches("h"));
        REQUIRE(glob.matches("n"));
        REQUIRE(!glob.matches("john"));
    }

    SECTION("Range match") {
        auto glob = globber::Glob("[a-d]", 0);
        REQUIRE(glob.valid());
        REQUIRE(glob.matches("a"));
        REQUIRE(glob.matches("b"));
        REQUIRE(glob.matches("c"));
        REQUIRE(glob.matches("d"));
        REQUIRE(!glob.matches("abcd"));
    }

    SECTION("Wildcard of one") {
        auto glob = globber::Glob("?", 0);
        REQUIRE(glob.valid());
        REQUIRE(glob.matches("a"));
        REQUIRE(glob.matches("b"));
        REQUIRE(glob.matches("c"));
        REQUIRE(glob.matches("d"));
        REQUIRE(!glob.matches("abcd"));
    }

    SECTION("Wildcard of one path ") {
        auto glob = globber::Glob("C:/Users?", 0);
        REQUIRE(glob.valid());
        REQUIRE(!glob.matches("C:/Users"));
        REQUIRE(glob.matches("C:/Usersa"));
    }

    SECTION("Wildcard of many") {
        auto glob = globber::Glob("*", 0);
        REQUIRE(glob.valid());
        REQUIRE(glob);
        REQUIRE(glob.matches("a"));
        REQUIRE(glob.matches("b"));
        REQUIRE(glob.matches("c"));
        REQUIRE(glob.matches("d"));
        REQUIRE(glob.matches("abcd"));
        REQUIRE(glob.matches("john"));
    }

#if ROCKETRIDE_PLAT_WIN
    SECTION("Windows") {
        SECTION("Os prefix parsing") {
            Text matchStr = "<Windows*>?:/*/*/ntuser.dat*";
            auto res = globber::parseAndRemoveOsQualifier(matchStr);
            REQUIRE(res);
            REQUIRE(res.value() == plat::Type::Windows);
            REQUIRE(matchStr == "?:/*/*/ntuser.dat*");
        }

        SECTION("Registry glob any drive") {
            auto glob = globber::Glob("?:/*/*/ntuser.dat*", 0);
            REQUIRE(glob.valid());
            REQUIRE(glob);
            REQUIRE(glob.matches("c:/windows/system32/config/ntuser.dat"));
            REQUIRE(glob.matches("c:/windows/config/ntuser.dat"));
        }

        SECTION("Registry glob any drive trailing range") {
            auto glob = globber::Glob("?:/*/*/ntuser.dat*[t]", 0);
            REQUIRE(glob.valid());
            REQUIRE(glob);
            REQUIRE(!glob.matches("c:/windows/system32/config/ntuser.dat"));
        }

        SECTION("Registry glob c explicit") {
            auto glob = globber::Glob("c:/*/*/ntuser.dat*", 0);
            REQUIRE(glob.valid());
            REQUIRE(glob);
            REQUIRE(glob.matches("c:/windows/system32/config/ntuser.dat"));
            REQUIRE(glob.matches("C:/windows/system32/config/ntuser.dat"));
            REQUIRE(!glob.matches("d:/windows/system32/config/ntuser.dat"));
            REQUIRE(!glob.matches("d:/windows/system32/config/ntuser.da"));
            REQUIRE(!glob.matches("d:/windows/system32/config/ntuser.d"));
            REQUIRE(!glob.matches("d:/windows/system32/config/ntuser."));
            REQUIRE(!glob.matches("d:/windows/system32/config/ntuser"));
            REQUIRE(!glob.matches("d:/windows/system32/config/ntuseradat"));
            REQUIRE(!glob.matches("c:/windows"));
            REQUIRE(!glob.matches("c:/windows"));
        }

        SECTION("Recycle bin") {
            auto glob = globber::Glob("?:/*/*/ntuser.dat*", 0);
            REQUIRE(!glob.matches("C:/$Recycle.Bin"));
        }

        SECTION("Excludes no trailing wildcard") {
            auto glob =
                globber::Glob("c:/rocketride/build/rocketride/debug/agent", 0);
            REQUIRE(glob.matches(
                "c:/rocketride/build/rocketride/debug/agent/bobo"));
            REQUIRE(glob.matches("c:/rocketride/build/rocketride/debug/agent"));
        }

        SECTION("Excludes trailing wildcard") {
            auto glob = globber::Glob(
                "c:/rocketride/build/rocketride/debug/agent/*", 0);
            REQUIRE(glob.matches(
                "c:/rocketride/build/rocketride/debug/agent/bobo"));
            REQUIRE(
                !glob.matches("c:/rocketride/build/rocketride/debug/agent"));
        }
    }
#endif
}
