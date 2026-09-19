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


#include <apLib/ap.h>

#include <limits.h>
#include <mach-o/dyld.h>

namespace ap::application {

// Resolves the executable path from the mach-o loader
// @returns
// Zero, or ENAMETOOLONG if PATH_MAX was not enough
int detectExecPath() noexcept {
    std::array<char, PATH_MAX> execPath{};
    uint32_t execPathsize = PATH_MAX;

    // Non-zero means the buffer was too small, execPathsize gets the size needed
    if (::_NSGetExecutablePath(&execPath[0], &execPathsize)) {
        log::write(_location, "Failed to determine app path: needs {} bytes", execPathsize);
        return ENAMETOOLONG;
    }

    cmdline().setExecPath(&execPath[0]);
    return 0;
}

}  // namespace ap::application
