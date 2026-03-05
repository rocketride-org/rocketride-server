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

namespace ap {

// Define the Win32 error category, representing a platform
// error on the windows subsystem
struct Win32ErrorCategory : std::error_category {
    const char *name() const noexcept override;
    std::string message(int ev) const override;
};

const char *Win32ErrorCategory::name() const noexcept { return "win32"; }

std::string Win32ErrorCategory::message(int code) const {
    // Anything negative is com
    _const auto trimChars = {'\t', '\n', '\r', ' ', '\0', '.'};
    if (code < 0) {
        try {
            _com_error err(code);
            return string::trim(err.ErrorMessage(), trimChars);
        } catch (...) {
            return "N/A";
        }
    } else {
        char error[256];
        auto len =
            FormatMessage(FORMAT_MESSAGE_FROM_SYSTEM, NULL, _cast<DWORD>(code),
                          0, error, sizeof(error), NULL);
        if (len == 0) return "N/A";
        // trim trailing newline
        while (len && (error[len - 1] == '\r' || error[len - 1] == '\n')) --len;
        return string::trim({error, len}, trimChars);
    }
}

// Instantiate the global error category instance
const Win32ErrorCategory ErrorCategory{};

// Make win32 error code
ErrorCode make_error_code(DWORD code) noexcept {
    return std::error_code{_cast<int>(code), ErrorCategory};
}

}  // namespace ap
