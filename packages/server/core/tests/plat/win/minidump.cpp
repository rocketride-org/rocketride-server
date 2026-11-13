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

    SECTION("writes a dump") {
        // Create the crash dump
        ap::plat::createMinidump(SIGABRT);

        // Verify results
        REQUIRE(crashDumpCreated);
        REQUIRE(file::exists(minidumpPath));
    }

    // The crash handlers ask dev::dumpsEnabled() the same way
    SECTION("dev::dumpProcess() writes one only with --dumps") {
        auto oldDumps = ap::dev::Dumps.val();
        util::Guard restoreDumps = [&] { ap::dev::Dumps.setValue(oldDumps); };

        // Unset, false, or a value that is not a boolean
        for (const char *value : {"", "false", "C:\\dumps"}) {
            CAPTURE(value);
            ap::dev::Dumps.setValue(value);
            REQUIRE(ap::dev::dumpProcess() == Ec::NotSupported);
            REQUIRE(!crashDumpCreated);
        }

        // A bare --dumps reaches the engine as "true"
        ap::dev::Dumps.setValue("true");
        REQUIRE(!ap::dev::dumpProcess());
        REQUIRE(crashDumpCreated);
        REQUIRE(file::exists(minidumpPath));
    }
}
