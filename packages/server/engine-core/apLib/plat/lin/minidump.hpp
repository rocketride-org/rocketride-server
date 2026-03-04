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

#ifndef AP_PLAT_MINIDUMP_CPP_PRIVATE_INCLUDE
#error Must only be included from another cpp to prevent breakpad headers infecting rest of code
#endif  // ndef AP_PLAT_MINIDUMP_CPP_PRIVATE_INCLUDE

#undef AP_PLAT_MINIDUMP_CPP_PRIVATE_INCLUDE

namespace google_breakpad {

using std::string;
using std::wstring;

}  // namespace google_breakpad

#include <client/linux/handler/exception_handler.h>

namespace ap::plat {

namespace internal {

inline bool minidumpSignalContinueEnabled{};

inline bool& minidumpSignalerContinue() noexcept {
    // Normally this would be a static and not a global but the program has
    // crashed and doing std locks for static variables might be dangerous
    // this in this case better to use a global since it's safer
    // and the global is guaranteed to be initialized before this routine
    // would ever be called.
    return minidumpSignalContinueEnabled;
}

// forward declare real handler
void actualHandleMinidumpCallback(bool succeeded, void* context) noexcept;

inline bool filterMinidumpCallback(void* context) {
    // If we're being cancelled (e.g. due to SIGINT), don't write a dump
    if (async::cancelled(_location, true)) return false;

    // In case writing the crash dump fails, print and log that we have
    // encountered a terminal error first
    std::cerr << "FATAL ERROR: Application has terminated unexpectedly"
              << std::endl;
    return true;
}

inline bool handleMinidumpCallback(
    const google_breakpad::MinidumpDescriptor& descriptor, void* context,
    bool succeeded) noexcept {
    actualHandleMinidumpCallback(succeeded, context);

    return false;
}

}  // namespace internal

void minidumpAltSignalHandlersEnable() noexcept {
    internal::minidumpSignalerContinue() = true;
}

void minidumpAltSignalHandlersDisable() noexcept {
    internal::minidumpSignalerContinue() = false;
}

class Minidump {
public:
    Minidump() noexcept
        : m_path{dev::crashDumpLocation()},
          m_descriptor{_ts(m_path).c_str()},
          m_eh{m_descriptor,
               internal::filterMinidumpCallback,
               internal::handleMinidumpCallback,
               this,
               true,
               -1},
          m_dumpFilePath{m_eh.minidump_descriptor().path(),
                         internal::getMinidumpPathAllocator()} {}

    ~Minidump() noexcept = default;

    auto& filePath() const noexcept { return m_dumpFilePath; }

private:
    file::Path m_path;
    google_breakpad::MinidumpDescriptor m_descriptor;
    google_breakpad::ExceptionHandler m_eh;
    file::FilePath<Utf8Chr, memory::ViewAllocator<Utf8Chr>> m_dumpFilePath;
};

namespace internal {

inline void actualHandleMinidumpCallback(bool succeeded,
                                         void* context) noexcept {
    auto& mini = *(reinterpret_cast<Minidump*>(context));

    // Notify via the callback if configured (e.g. to send the path to the
    // monitor)
    if (succeeded) {
        if (dev::crashDumpCreatedCallback())
            dev::crashDumpCreatedCallback()(mini.filePath());

        LOG(Always, "Minidump created:", mini.filePath());
    }
}

}  // namespace internal

}  // namespace ap::plat
