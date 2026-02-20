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

#pragma once

namespace ap::plat {

inline Error createMinidump(::PEXCEPTION_POINTERS pExceptionInfo,
                            const file::Path &path) noexcept {
    wil::unique_hfile hFile(::CreateFileW(path.plat(), GENERIC_WRITE, 0,
                                          nullptr, CREATE_ALWAYS,
                                          FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!hFile)
        return APERR(::GetLastError(), "Unable to create minidump file", path);

    uint32_t minidumpType = MiniDumpNormal;
    // When the heap log channel is enabled, or we are a debug build, create
    // full dumps
    if (log::isLevelExplicitlyEnabled(Lvl::Heap) || plat::IsDebug) {
        // These are the flags used when creating a dump from Task Manager
        minidumpType = MiniDumpWithFullMemory | MiniDumpWithHandleData |
                       MiniDumpWithUnloadedModules |
                       MiniDumpWithFullMemoryInfo | MiniDumpWithThreadInfo |
                       MiniDumpIgnoreInaccessibleMemory;
        // MiniDumpWithIptTrace;	// Not completely sure what this flag does,
        // and it doesn't seem critical-- elide it
    }

    ::MINIDUMP_EXCEPTION_INFORMATION info = {};
    info.ThreadId = ::GetCurrentThreadId();
    info.ExceptionPointers = pExceptionInfo;
    if (!::MiniDumpWriteDump(::GetCurrentProcess(), ::GetCurrentProcessId(),
                             hFile.get(), _cast<MINIDUMP_TYPE>(minidumpType),
                             &info, nullptr, nullptr))
        return APERR(::GetLastError(), "Unable to create minidump", path);

    // Always log the minidump path
    LOG(Always, "Created minidump: ", path);

    // Notify via the callback if configured (e.g. to send the path to the
    // monitor)
    if (dev::crashDumpCreatedCallback()) dev::crashDumpCreatedCallback()(path);

    return {};
}

inline Error createMinidump(::PEXCEPTION_POINTERS pExceptionInfo) noexcept {
    return createMinidump(pExceptionInfo, dev::createCrashDumpPath("mdmp"_tv));
}

inline DWORD exceptionFilter(::PEXCEPTION_POINTERS pExceptionInfo,
                             Error &error) {
    error = createMinidump(pExceptionInfo);
    return _cast<DWORD>(EXCEPTION_CONTINUE_EXECUTION);
}

inline void createMinidumpWithStack(int signal, Error &error) noexcept {
    __try {
        ::RaiseException(signal, 0, 0, nullptr);
    } __except (exceptionFilter(GetExceptionInformation(), error)) {
    }
}

inline Error createMinidump(int signal = SIGABRT) noexcept {
    // If no exception pointer is available, the stack trace for this thread
    // won't be available in the minidump, so force an exception
    Error error;
    createMinidumpWithStack(signal, error);
    return error;
}

}  // namespace ap::plat
