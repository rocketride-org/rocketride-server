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
#include <csignal>
#include <filesystem>
#include <set>

TEST_CASE("plat::createMinidump") {
    // Set the crash dump location to our test path (and restore it when done)
    auto oldCrashDumpLocation = ap::dev::crashDumpLocation();
    util::Guard restoreCrashDumpLocation = [&] {
        ap::dev::crashDumpLocation(oldCrashDumpLocation);
    };
    ap::dev::crashDumpLocation(testPath());

    // Set the crash dump created callback (and restore it when done)
    auto oldCrashDumpCreatedCallback = ap::dev::crashDumpCreatedCallback();
    util::Guard restoreCrashDumpCreatedCallback = [&] {
        ap::dev::crashDumpCreatedCallback() = oldCrashDumpCreatedCallback;
    };
    bool crashDumpCreated = false;
    file::Path minidumpPath;
    ap::dev::crashDumpCreatedCallback() = [&](const file::Path &path) {
        crashDumpCreated = true;
        minidumpPath = path;
    };

    // Dumps are opt-in (and restore the flag when done)
    auto oldDumps = ap::dev::Dumps.val();
    util::Guard restoreDumps = [&] { ap::dev::Dumps.setValue(oldDumps); };

    // A bare --dumps reaches the engine as "true"
    SECTION("--dumps writes a dump") {
        ap::dev::Dumps.setValue("true");

        // Create the crash dump
        ap::plat::createMinidump(SIGABRT);

        // Verify results
        REQUIRE(crashDumpCreated);
        REQUIRE(file::exists(minidumpPath));
    }

    SECTION("without --dumps no dump is written") {
        // The .mdmp files in the test path
        auto dumps = [] {
            std::set<std::filesystem::path> out;
            for (const auto &e :
                 std::filesystem::directory_iterator(testPath().stdPath()))
                if (e.path().extension() == ".mdmp") out.insert(e.path());
            return out;
        };

        // Unset, or a value: the engine refuses one at startup, and none turns
        // dumps on
        for (const char *value : {"", "false", "1", "C:\\dumps"}) {
            CAPTURE(value);
            ap::dev::Dumps.setValue(value);
            auto before = dumps();

            ap::plat::createMinidump(SIGABRT);

            REQUIRE(!crashDumpCreated);
            REQUIRE(dumps() == before);
        }
    }
}

// What application::init() refuses at startup. Linux and macOS check that end
// to end in the "crashpad" test, with a real child process.
TEST_CASE("dev::dumpsValueArg") {
    // No --dumps, a bare one in any case, or another option
    REQUIRE(!ap::dev::dumpsValueArg({"aptest"}));
    REQUIRE(!ap::dev::dumpsValueArg({"aptest", "--dumps"}));
    REQUIRE(!ap::dev::dumpsValueArg({"aptest", "--DUMPS"}));
    REQUIRE(!ap::dev::dumpsValueArg({"aptest", "--dumpster=1"}));

    // Any value, even "true" or an empty one
    for (const char *arg : {"--dumps=", "--dumps=true", "--Dumps=C:\\dumps"}) {
        CAPTURE(arg);
        REQUIRE(ap::dev::dumpsValueArg({"aptest", "--stream", arg}) ==
                Text{arg});
    }
}
