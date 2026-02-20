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

#include <apLib/ap.h>
#include "version.h"

namespace ap::application {

// Exit quickly without deconstructing globals
void quickExit(int code) noexcept {
#if ROCKETRIDE_PLAT_MAC
    _exit(code);
#else
    std::quick_exit(code);
#endif
}

// Return the CmdLine that was used during startup of this application
// instance
CmdLine &cmdline() noexcept {
    static CmdLine s_cmdline;
    return s_cmdline;
}

// Accesses our global command-line argument count
int argc() noexcept { return cmdline().argc(); }

// Accesses our global command-line argument vector
const char **argv() noexcept { return cmdline().argv(); }

// Accesses our global command-line argument count
const std::vector<Text> &args() noexcept { return cmdline().args(); }

// Returns the absolute path to the application executable
file::Path execPath(bool stripExec) noexcept {
    return cmdline().execPath(stripExec);
}

// Returns the global build hash set at compilation time, this hash is
// the git revision in the engine repo

TextView buildHash() noexcept {
#if defined(ROCKETRIDE_BUILD_HASH_SHORT)
    return ROCKETRIDE_BUILD_HASH_SHORT;
#else
    return {};
#endif
}

// Returns the global build hash set at compilation time
TextView buildStamp() noexcept {
#if defined(ROCKETRIDE_BUILD_STAMP)
    return ROCKETRIDE_BUILD_STAMP;
#else
    return {};
#endif
}

// Returns the CMAKE project version
Text projectVersion() noexcept {
    std::vector<TextView> versionComponents;
#if defined(CMAKE_PROJECT_VERSION_MAJOR)
    versionComponents.push_back(CMAKE_PROJECT_VERSION_MAJOR);
#if defined(CMAKE_PROJECT_VERSION_MINOR)
    versionComponents.push_back(CMAKE_PROJECT_VERSION_MINOR);
#if defined(CMAKE_PROJECT_VERSION_PATCH)
    versionComponents.push_back(CMAKE_PROJECT_VERSION_PATCH);
#if defined(CMAKE_PROJECT_VERSION_TWEAK)
    versionComponents.push_back(CMAKE_PROJECT_VERSION_TWEAK);
#endif
#endif
#endif
#endif
    return string::concat(versionComponents, "."_tv);
}

}  // namespace ap::application
