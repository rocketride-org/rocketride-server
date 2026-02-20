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

#include <apLib/ap.h>

namespace ap {
// Define the rocketride error category, representing rocketride
// error codes
struct RocketRideErrorCategory : std::error_category {
    const char* name() const noexcept override;
    std::string message(int ev) const override;
};

const char* RocketRideErrorCategory::name() const noexcept { return "ap"; }

std::string RocketRideErrorCategory::message(int ev) const {
    return _ts(EnumFrom<Ec>(ev));
}

// Instantiate the global error category instance
static const RocketRideErrorCategory g_rocketride{};

// Make an rocketride error code
ErrorCode make_error_code(Ec code) noexcept {
    return std::error_code{_cast<int>(code), g_rocketride};
}

}  // namespace ap
