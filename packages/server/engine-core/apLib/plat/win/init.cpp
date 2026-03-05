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

namespace ap::plat {

void init() noexcept {
    // Init com
    plat::ComInit::init();

    // Enable VT-100 control code processing on the console
    HANDLE hConsole = ::GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD value;
    ::GetConsoleMode(hConsole, &value);
    // If the function fails, disable colors
    if (!::SetConsoleMode(hConsole, value | ENABLE_VIRTUAL_TERMINAL_PROCESSING))
        log::options().disableAllColors = true;

    // Set the code page to UTF-8
    ::SetConsoleOutputCP(65001);

    // Add backup rights to process
    ASSERTD_MSG(!addRights(),
                "Could not adjust process privilege for backup rights");

    // Install console control handler
    ::SetConsoleCtrlHandler(plat::consoleEventHandler, TRUE);

    // Set the COM error handler to log instead of throwing an exception
    ::_set_com_error_handler([](HRESULT hr, IErrorInfo *) noexcept {
        // If error logging is enabled, construct and log an Error from the
        // HRESULT
        if (log::isLevelEnabled<false>(Lvl::Error))
            APERR(hr, "Global COM error");
    });

    // Init the socket manager
    ::WSADATA wsaData = {};
    if (auto socketStatus = ::WSAStartup(MAKEWORD(2, 2), &wsaData))
        ASSERTD_MSG(false, "Unable to start socket manager", socketStatus);
}

void deinit() noexcept {
    // Deinit the socket manager
    ::WSACleanup();
}

}  // namespace ap::plat
