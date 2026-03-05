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

#include <setjmp.h>
#include <filesystem>
#include <set>

static jmp_buf jbuf;

static bool &crashCheck() {
    static bool value{};
    return value;
}

// List of signals to intercept not including every single one of them
_const std::array TestSigList = {
    // Termination request signal
    SIGTERM,

    // Critical signals
    SIGFPE, SIGILL, SIGSEGV, SIGBUS, SIGABRT, SIGPIPE,

    // Non critical signals
    SIGINT, SIGQUIT, SIGHUP};

// De-registers the signal handler
static void testDisableSignalHandler() noexcept {
    LOG(Always, "De-registering all handlers");

    for (auto sig : TestSigList) ::signal(sig, SIG_DFL);
}

// Signal handler for Linux.
static void testSignalHandler(int sig) noexcept {
    crashCheck() = true;

    LOG(Always, "Fired testSignalHandler");

    siglongjmp(jbuf, 1);
}

// Setup all the signal handlers
static void testSetupSignalHandler() noexcept {
    // Setup sigaction object
    struct ::sigaction sigact;
    sigact.sa_handler = testSignalHandler;
    sigact.sa_flags = 0;

    // Register handler for all signals we are intercepting
    sigemptyset(&sigact.sa_mask);
    for (auto sig : TestSigList) {
        ::sigaddset(&sigact.sa_mask, sig);
    }
    for (auto sig : TestSigList) {
        ::sigaction(sig, &sigact, nullptr);
    }
}

TEST_CASE("breakpad", "[.]") {
    SECTION("autocrash") {
        SECTION("check_for_new_dump") {
            plat::minidumpDeregister();
            testDisableSignalHandler();

            auto crashPath = dev::crashDumpLocation();

            std::set<std::filesystem::path> dumpFiles;

            for (const auto &entry :
                 std::filesystem::directory_iterator(crashPath)) {
                auto entryPath = entry.path();
                auto ext = entryPath.extension();
                if (".dmp" != ext) continue;

                LOG(Always, "Previous dump file:", entry.path());
                dumpFiles.insert(entryPath);
            }

            auto result = sigsetjmp(jbuf, !0);
            if (result == 0) {
                testSetupSignalHandler();
                plat::minidumpRegister();

                plat::minidumpAltSignalHandlersEnable();

                auto crashLambda = []() {
                    volatile int *a = (int *)(NULL);
                    *a = 1;
                };

                crashLambda();
            }

            REQUIRE(crashCheck());

            bool newDumpEntry{};
            for (const auto &entry :
                 std::filesystem::directory_iterator(crashPath)) {
                auto entryPath = entry.path();
                auto ext = entryPath.extension();
                if (".dmp" != ext) continue;

                auto found = dumpFiles.find(entryPath);
                if (found != dumpFiles.end()) continue;

                LOG(Always, "New dump file:", entry.path());
                newDumpEntry = true;
                break;
            }

            REQUIRE(newDumpEntry);
        }
    }
}
