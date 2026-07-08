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

#include <sys/wait.h>
#include <unistd.h>
#include <cstdlib>
#include <filesystem>
#include <set>

// The .dmp files currently in the crash-dump directory.
static std::set<std::filesystem::path> dumpsIn(
    const std::filesystem::path &dir) {
    std::set<std::filesystem::path> out;
    std::error_code ec;
    if (!std::filesystem::exists(dir, ec)) return out;
    for (const auto &e : std::filesystem::directory_iterator(dir, ec))
        if (e.path().extension() == ".dmp") out.insert(e.path());
    return out;
}

// Re-exec this test binary as a fresh process (RR_CRASH_CHILD handled in
// testMain.ipp) so the child registers Crashpad and faults/exits without the
// fork-in-a-threaded-process deadlock a plain fork() would hit. Returns the
// child's wait status.
static int runCrashChild(const char *mode) {
    auto exe = _ts(application::execPath());
    // Resolve the handler here (parent) and hand it to the child explicitly: a
    // re-exec'd child can compute an empty execDir(), so it can't self-locate the
    // handler sitting next to the binary.
    auto handler = _ts(application::execDir() / "crashpad_handler");

    pid_t pid = ::fork();
    REQUIRE(pid >= 0);
    if (pid == 0) {
        ::setenv("RR_CRASH_CHILD", mode, 1);
        ::setenv("ROCKETRIDE_CRASHPAD_HANDLER", handler.c_str(), 1);
        char *const argv[] = {const_cast<char *>(exe.c_str()), nullptr};
        ::execv(exe.c_str(), argv);
        ::_exit(127);  // exec failed
    }

    // Poll with a timeout so a wedged handler can never hang the suite.
    int status{};
    for (int i = 0; i < 200; ++i) {
        if (::waitpid(pid, &status, WNOHANG) == pid) return status;
        ::usleep(100 * 1000);  // 100ms * 200 = 20s cap
    }
    ::kill(pid, SIGKILL);
    ::waitpid(pid, &status, 0);
    FAIL("crash child did not exit within timeout");
    return status;
}

// Crashpad's handler is out-of-process, so a crash must be observed from a
// separate process. crashpad_handler is copied next to the test binary by
// CMake; ROCKETRIDE_CRASHPAD_HANDLER can override. Skips if neither is present.
TEST_CASE("crashpad") {
    auto handler = application::execDir() / "crashpad_handler";
    if (!plat::env("ROCKETRIDE_CRASHPAD_HANDLER") && !file::exists(handler)) {
        WARN("crashpad_handler not found next to test binary; skipping");
        return;
    }

    std::filesystem::path crashDir{_ts(dev::crashDumpLocation()).c_str()};

    SECTION("crash writes a recoverable dump") {
        auto before = dumpsIn(crashDir);

        int status = runCrashChild("crash");
        REQUIRE(WIFSIGNALED(status));

        // The parent's sweep relocates the child's dump into crashDumpLocation().
        plat::minidumpRegister();

        REQUIRE(dumpsIn(crashDir).size() > before.size());
    }

    SECTION("clean exit writes no dump") {
        auto before = dumpsIn(crashDir);

        int status = runCrashChild("clean");
        REQUIRE(WIFEXITED(status));

        plat::minidumpRegister();

        REQUIRE(dumpsIn(crashDir) == before);
    }
}
