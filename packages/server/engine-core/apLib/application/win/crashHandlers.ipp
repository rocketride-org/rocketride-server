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
#include <csignal>

// Shared by every Windows entry point (winmain.ipp, engine.cpp's engine_run)
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

// Skipped under a debugger so a crash breaks at the fault site, not here
inline void installCrashHandlers() noexcept {
    if (!::IsDebuggerPresent()) {
        ::SetUnhandledExceptionFilter(unhandledExceptionFilter);
        std::signal(SIGABRT, abortHandler);
    }
}
