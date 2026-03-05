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

#pragma once

#ifdef ROCKETRIDE_PLAT_UNX
#include <signal.h>
#endif

namespace ap::dev {

namespace {
// This singleton helps us track recursive asserts, prevents a layered
// one from executing if one is already active
bool &fatalityExecuting() noexcept {
    static bool flag = false;
    return flag;
}
}  // namespace

// Breaks the process on debug builds, optionally logs the location and
// variable arguments (if specified). On windows this amounts to a call
// to DebugBreak, posix systems we self signal SIGINT.
template <typename... DebugInfo>
inline void enterDebugger(Location location, DebugInfo &&...info) noexcept {
    auto message = _tsd<' ', Format::ERROROROK>(
        Color::Red, "!!!Assertion!!! ", location,
        std::forward<DebugInfo>(info)..., Backtrace(), Color::Reset);
    log::write(_location, message);
    ::fflush(stdout);

#if defined(ROCKETRIDE_PLAT_WIN)
    if (::IsDebuggerPresent()) ::DebugBreak();
#else
    ::kill(::getpid(), SIGINT);
#endif
}

// End of the line
template <typename... DebugInfo>
[[noreturn]] inline void fatality(Location location,
                                  DebugInfo &&...info) noexcept {
    if (!_exch(fatalityExecuting(), true)) {
        log::write(location, Color::Red,
                   "Fatal:", std::forward<DebugInfo>(info)..., '\n',
                   Backtrace());
        ::fflush(stdout);

        onFatality(location, _tsd<' ', Format::ERROROROK>(
                                 std::forward<DebugInfo>(info)...));
    }

#if defined(ROCKETRIDE_PLAT_WIN)
    if (::IsDebuggerPresent()) ::DebugBreak();
#elif defined(ROCKETRIDE_PLAT_LINUX)
    ::kill(::getpid(), SIGINT);
#elif defined(ROCKETRIDE_PLAT_MAC)
    ::raise(SIGINT);
#endif

#if ROCKETRIDE_PLAT_UNX
    std::abort();
#else
    std::quick_exit(1);
#endif
}

const file::Path &crashDumpLocation() noexcept;
void crashDumpLocation(const file::Path &path) noexcept;

Text &crashDumpPrefix() noexcept;
Text createCrashDumpName(TextView extension) noexcept;

inline file::Path createCrashDumpPath(TextView extension) noexcept {
    auto directory{crashDumpLocation()};
    if (!file::exists(directory)) {
        LOG(Error,
            "Specified crash dump directory does not exist; using system temp "
            "directory",
            directory);
        directory = std::filesystem::temp_directory_path();
    }

    return directory / createCrashDumpName(extension);
}

using CrashDumpCreatedCallback = Function<void(const file::Path &)>;

inline CrashDumpCreatedCallback &crashDumpCreatedCallback() noexcept {
    static CrashDumpCreatedCallback callback;
    return callback;
}

}  // namespace ap::dev
