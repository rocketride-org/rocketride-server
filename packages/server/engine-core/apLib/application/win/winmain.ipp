// =============================================================================
// MIT License
//
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
#include <apLib/application/win/crashHandlers.ipp>

// The main entry point for an rocketride based executable, in the windows
// case the strings are ucs2 which we convert to utf8 inline
int wmain(int argc, const WCHAR **argv) noexcept {
    using namespace ap;

    // On exit check the heap
#if ROCKETRIDE_BUILD_DEBUG
    // We know there are leaks, for now this just gets in the way so disable it
    // std::atexit(reinterpret_cast<void(__cdecl
    // *)(void)>(::_CrtDumpMemoryLeaks));
#endif

    // Set the global commandline
    ::ap::application::cmdline() = {argc, argv};

    // Initialize apLib
    auto initScope = ::ap::init();

    // Determine our app path
    if (auto err = ::ap::application::detectExecPath()) return err;

    installCrashHandlers();

    // Call main with blocking and translation of exceptions to errors
    auto res = ::ap::error::call(
        _location, [&] { return ::ap::application::Main().value(); });

    // Return the error code if one was returned
    if (!res) return res.ccode().plat();

    return *res;
}
