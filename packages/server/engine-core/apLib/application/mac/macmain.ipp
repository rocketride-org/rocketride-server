// =============================================================================
// MIT License
// Copyright (c) 2024 RocketRide Inc.
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
#include <mach-o/dyld.h>
#include <limits.h>

// The main entry point for an rocketride based executable
int main(int argc, const char **argv) noexcept {
    // Set the global commandline
    ::ap::application::cmdline() = {argc, argv};

    {
        std::array<char, PATH_MAX> execPath{};
        uint32_t execPathsize = PATH_MAX;
        ASSERTD(!::_NSGetExecutablePath(&execPath[0], &execPathsize));

        // Set this as the applications exec path
        ::ap::application::cmdline().setExecPath(&execPath[0]);
    }

    // Ready the core
    auto initScope = ::ap::init();

    // Call main with blocking and translation of exceptions to errors
    auto res = ::ap::error::call(
        _location, [&] { return ::ap::application::Main().value(); });

    // Return the error code if one was returned
    if (!res) return res.ccode().plat();

    return *res;
}
