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

TEST_CASE("log::Levels") {
    SECTION("Conversion from string") {
        for (auto l : Lvl{}) {
            REQUIRE(log::mapLogLevel(_ts(EnumIndex(l))) == l);
        }
    }

    SECTION("Case-insensitive conversion from string") {
        for (auto l : Lvl{}) {
            REQUIRE(log::mapLogLevel(_ts(EnumIndex(l)).upperCase()) == l);
        }
    }

    SECTION("Test") {
        REQUIRE_FALSE(log::isLevelEnabled(Lvl::Error));
        log::enableLevel("dev,perf");
        REQUIRE_FALSE(log::isLevelEnabled(Lvl::Error));
    }

    SECTION("Enable/disable level") {
        log::enableLevel(Lvl::Work);
        REQUIRE(log::isLevelEnabled(Lvl::Work));
        log::disableLevel(Lvl::Work);
        REQUIRE_FALSE(log::isLevelEnabled(Lvl::Work));
    }

    SECTION("Sticky bit") {
        log::enableLevel<true>(Lvl::Work);
        REQUIRE(log::isLevelEnabled(Lvl::Work));
        log::disableAllLevels();
        REQUIRE(log::isLevelEnabled(Lvl::Work));
        log::disableLevel(Lvl::Work);
        REQUIRE_FALSE(log::isLevelEnabled(Lvl::Work));
    }

    SECTION("Multiple enable") {
        log::enableLevel(Lvl::Work, Lvl::Work);
        log::disableLevel(Lvl::File);
        REQUIRE(log::isLevelEnabled(Lvl::Work, Lvl::Work));
        REQUIRE(log::isLevelEnabled(Lvl::Work));
        REQUIRE(log::isLevelEnabled(Lvl::Work));
        REQUIRE_FALSE(log::isLevelEnabled(Lvl::Work, Lvl::Work, Lvl::File));

        SECTION("Multiple disable") {
            log::disableLevel(Lvl::Work, Lvl::Work, Lvl::File);
            REQUIRE_FALSE(log::isLevelEnabled(Lvl::Work, Lvl::Work));
            REQUIRE_FALSE(log::isLevelEnabled(Lvl::Work));
            REQUIRE_FALSE(log::isLevelEnabled(Lvl::Work));
            REQUIRE_FALSE(log::isLevelEnabled(Lvl::Work, Lvl::Work, Lvl::File));
        }
    }

    SECTION("Multiple name enable") {
        log::enableLevel("WORK", "WORK");
        log::disableLevel("CONNECTION");
        REQUIRE(log::isLevelEnabled("WORK", "WORK"));
        REQUIRE(log::isLevelEnabled("WORK"));
        REQUIRE(log::isLevelEnabled("WORK"));
        REQUIRE_FALSE(log::isLevelEnabled("WORK", "WORK", "CONNECTION"));

        SECTION("Multiple name disable") {
            log::disableLevel("WORK", "WORK", "CONNECTION");
            REQUIRE_FALSE(log::isLevelEnabled("WORK", "WORK"));
            REQUIRE_FALSE(log::isLevelEnabled("WORK"));
            REQUIRE_FALSE(log::isLevelEnabled("WORK"));
            REQUIRE_FALSE(log::isLevelEnabled("WORK", "WORK", "CONNECTION"));
        }
    }

    SECTION("Multiple name enable with whitespaces at beginning and/or end") {
        log::enableLevel(" WORK", " WORK ");
        log::disableLevel(" CONNECTION");
        REQUIRE(log::isLevelEnabled("WORK", "WORK"));
        REQUIRE(log::isLevelEnabled("WORK"));
        REQUIRE(log::isLevelEnabled("WORK"));
        REQUIRE_FALSE(log::isLevelEnabled("WORK", "WORK", "CONNECTION"));

        SECTION(
            "Multiple name disable with whitespaces at beginning and/or end") {
            log::disableLevel(" WORK ", " WORK ", " CONNECTION ");
            REQUIRE_FALSE(log::isLevelEnabled("WORK", "WORK"));
            REQUIRE_FALSE(log::isLevelEnabled("WORK"));
            REQUIRE_FALSE(log::isLevelEnabled("WORK"));
            REQUIRE_FALSE(log::isLevelEnabled("WORK", "WORK", "CONNECTION"));
        }
    }
}
