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
#include <csignal>

// Forward declarations of exception handlers
LONG WINAPI
unhandledExceptionFilter(::PEXCEPTION_POINTERS pExceptionInfo) noexcept;
void abortHandler(int signal) noexcept;

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

    // Determine our app path, in a frame so we don't park the stack
    // allocation for the duration of the apps run
    {
        std::array<Utf16Chr, MAX_PATH> execPath = {};

        if (!::GetModuleFileNameW(NULL, &execPath[0], MAX_PATH))
            return ::ap::log::write(_location,
                                    "Failed to determine app path: {,x0}",
                                    ::GetLastError());

        // Set this as the exec path
        ::ap::application::cmdline().setExecPath(&execPath[0]);
    }

    // Don't set the unhandled exception filter if there's a debugger attached--
    // if a crash occurs while debugging, you want to be taken to the site of
    // the crash, not to the unhandled exception filter
    if (!::IsDebuggerPresent()) {
        ::SetUnhandledExceptionFilter(unhandledExceptionFilter);
        std::signal(SIGABRT, abortHandler);
    }

    // Call main with blocking and translation of exceptions to errors
    auto res = ::ap::error::call(
        _location, [&] { return ::ap::application::Main().value(); });

    // Return the error code if one was returned
    if (!res) return res.ccode().plat();

    return *res;
}

LONG WINAPI
unhandledExceptionFilter(::PEXCEPTION_POINTERS pExceptionInfo) noexcept {
    using namespace ::ap;

    // If we're being cancelled, just exit
    if (async::cancelled(_location, true))
        dev::fatality(_location, APERR(Ec::Cancelled,
                                       "Application execution was cancelled"));

    // Print and log the error
    const Text errorStr =
        _fmt("Application caught unhandled SEH exception: {,x,8}",
             pExceptionInfo->ExceptionRecord->ExceptionCode);
    std::cerr << "FATAL ERROR: " << errorStr << std::endl;
    LOG(Always, errorStr);

    // Create a minidump of the crash (or the program state, if no exception
    // info is available)
    plat::createMinidump(pExceptionInfo);

    // Report the error and exit
    dev::fatality(_location, APERR(Ec::Fatality, errorStr));
}

void abortHandler(int signal) noexcept {
    using namespace ::ap;

    // If we're being cancelled, just exit
    if (async::cancelled(_location, true))
        dev::fatality(_location, APERR(Ec::Cancelled,
                                       "Application execution was cancelled"));

    // Print and log the error
    const Text errorStr =
        _fmt("Application received system signal: {}: {} ({})",
             plat::renderSignal(signal), plat::renderSignalDescription(signal),
             signal);
    std::cerr << "FATAL ERROR: " << errorStr << std::endl;
    LOG(Always, errorStr);

    // Create a minidump of the program state
    plat::createMinidump(signal);

    // Report the error and exit
    dev::fatality(_location, APERR(Ec::Fatality, errorStr));
}
