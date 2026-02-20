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

TEST_CASE("util::ConfigFile") {
    auto path = _ts(testPath("smb.conf"));

    SECTION("Lookup") {
        auto cfg = util::ConfigFile::open(path);
        REQUIRE(cfg);
        REQUIRE(cfg->lookup("[global] workgroup") == "SMITH");
        REQUIRE(cfg->lookup("[global] server string") ==
                "%h server (Samba, Ubuntu)");
        REQUIRE(cfg->lookup("[global] log file") == "/var/log/samba/log.%m");
        REQUIRE(cfg->lookup<Size>("[global] max log size") == 1000);
        REQUIRE(cfg->lookup("[global] logging") == "file");
        REQUIRE(cfg->lookup("[global] panic action") ==
                "/usr/share/samba/panic-action %d");

        REQUIRE(cfg->lookup("[Stuff] comment") == "Stuff... lots of stuff...");
        REQUIRE(cfg->lookup("[Stuff] path") == "/stuff");
        REQUIRE(cfg->lookup<bool>("[Stuff] browsable") == true);
        REQUIRE(cfg->lookup("[Stuff] browsable") == "yes");
    }

    SECTION("Apply") {
        auto cfg = util::ConfigFile::open(path);
        REQUIRE(cfg);
        REQUIRE(cfg->lookup<bool>("[global] dns proxy") == true);
        cfg->apply("[global] dns proxy", false);
        auto res = cfg->lookup<bool>("[global] dns proxy");
        REQUIRE(res == false);
        cfg->apply("[global] dns proxy", false);
        res = cfg->lookup<bool>("[global] dns proxy");
        REQUIRE(res == false);
        REQUIRE(!cfg->commit());
        cfg = util::ConfigFile::open(path);
        res = cfg->lookup<bool>("[global] dns proxy");
        REQUIRE(res == false);
        cfg->apply("[global] dns proxy", true);
        REQUIRE(!cfg->commit());
        cfg = util::ConfigFile::open(path);
        res = cfg->lookup<bool>("[global] dns proxy");
        REQUIRE(res == true);
    }

    SECTION("Remove") {
        auto cfg = util::ConfigFile::open(path);
        REQUIRE(cfg);
        REQUIRE(!cfg->lookup<bool>("[FULL_ARCHIVE] guest ok", true));
        REQUIRE(cfg->lookup<Text>("[FULL_ARCHIVE] create mask") == "0666");
        cfg->apply("[FULL_ARCHIVE] bobo", "bobo");
        REQUIRE(cfg->lookup<Text>("[FULL_ARCHIVE] bobo") == "bobo");
        REQUIRE(cfg->remove("[FULL_ARCHIVE] guest ok"));
        REQUIRE(cfg->lookup<bool>("[FULL_ARCHIVE] guest ok", true));
        REQUIRE(cfg->lookup<Text>("[FULL_ARCHIVE] create mask") == "0666");
        REQUIRE(cfg->remove("[FULL_ARCHIVE]"));
        REQUIRE(cfg->lookup<Text>("[FULL_ARCHIVE] create mask") == "");
        REQUIRE(!cfg->lookup<Text>("[FULL_ARCHIVE] bobo"));
        REQUIRE(!cfg->commit());
    }
}
