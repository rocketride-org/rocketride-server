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

// Define the Errno error category, representing a platform
// error on the windows subsystem
struct ErrnoErrorCategory : std::error_category {
    const char *name() const noexcept override;
    std::string message(int ev) const override;
};

const char *ErrnoErrorCategory::name() const noexcept { return "errno"; }

std::string ErrnoErrorCategory::message(int code) const {
    if (auto desc = strerror(code)) return string::trim(desc);
    return "N/A";
}

// Instantiate the global error category instance
static const ErrnoErrorCategory g_errno{};

// Make errno error code
ErrorCode make_error_code(int code) noexcept {
    return std::error_code{code, g_errno};
}

}  // namespace ap
