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

using namespace ap;

TEST_CASE("file::api") {
    auto root = testPath();

    SECTION("Put/fetch") {
        // UTF-8
        auto utf8 = "Some data"_tv;
        REQUIRE(!file::put(root / "file.txt", utf8));
        REQUIRE(*file::fetch<TextChr>(root / "file.txt") == utf8);
        REQUIRE(*file::fetchString<TextChr>(root / "file.txt") == utf8);

        // UTF-16
        auto utf16 = u"Some data"_tv;
        REQUIRE(!file::put(root / "file.txt", utf16));
        REQUIRE(*file::fetch<Utf16Chr>(root / "file.txt") == utf16);
        REQUIRE(*file::fetchString<Utf16Chr>(root / "file.txt") == utf16);

#if ROCKETRIDE_PLAT_LIN
        // Special files (e.g. /proc) don't have sizes
        _using(auto version = file::fetch("/proc/version")) {
            REQUIRE(*version);
            REQUIRE_FALSE(version->empty());
        }
        _using(auto version = file::fetchString("/proc/version")) {
            REQUIRE(*version);
            REQUIRE_FALSE(version->empty());
        }
#endif
    }

    SECTION("cwd") {
        LOG(Test, "Cwd:", file::cwd(), "Exec:", application::execDir());
        ASSERT(file::cwd());
    }

    SECTION("exists") {
        REQUIRE(!file::exists(root / "blah.txt"));
        REQUIRE(!file::put(root / "blah.txt", "Yadayada"_tv));
        LOG(Test, "Test path", root / "blah.txt");
        REQUIRE(file::exists(root / "blah.txt"));
    }

    SECTION("copy") {
        auto path = root / "source.txt";
        auto target = root / "target.txt";
        REQUIRE(!file::put(path, "Yadayada"_tv));
        REQUIRE(!file::copy(path, target));
        REQUIRE(file::exists(path));
        REQUIRE(file::exists(target));
        auto first = _mv(*file::fetch<TextChr>(path));
        auto second = _mv(*file::fetch<TextChr>(target));
        REQUIRE(first == second);
    }

    SECTION("mkdir/stat") {
        auto path = root / "a_folder";
        REQUIRE(!file::exists(path));
        REQUIRE(!file::mkdir(path));
        auto info = file::stat(path);
        REQUIRE(info);
        REQUIRE(info->isDir == true);
    }

    SECTION("type") {
        REQUIRE(file::isFile(application::execPath()));
        REQUIRE(!file::isFile(application::execDir()));
        if (file::isFile(application::execDir())) FAIL();

        REQUIRE(file::isDir(application::execDir()));
        REQUIRE(!file::isDir(application::execPath()));
        if (file::isDir(application::execPath())) FAIL();
    }

#if ROCKETRIDE_PLAT_WIN
    SECTION("Root stat") { *file::stat("c:"); }
#else
    SECTION("Root stat") { file::StatInfo stat = *file::stat("/"); }

    SECTION("stat vs platStat") {
        file::StatInfo stat = *file::stat("/");

        file::PlatStatInfo platStat;
        REQUIRE(0 == ::lstat("/", &platStat));

        // REQUIRE(sizeof(stat.plat) == sizeof(platStat));
        // REQUIRE(0 == ::memcmp(&stat.plat, &platStat, sizeof(stat.plat)));
    }

    SECTION("platStat vs platStatEx") {
        file::PlatStatInfo platStat;
        REQUIRE(0 == ::lstat("/", &platStat));

        file::PlatStatInfoEx platStatEx;
        // REQUIRE(0 == ::statx(AT_FDCWD, "/", 0, STATX_ALL, &platStatEx));

        file::PlatStatInfo platStatTr = _tr<file::PlatStatInfo>(platStatEx);
        // REQUIRE(0 == ::memcmp(&platStat, &platStatTr, sizeof(platStat)));
    }
#endif
}
