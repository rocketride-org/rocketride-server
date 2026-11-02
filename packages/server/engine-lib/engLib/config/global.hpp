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

namespace engine::config {

ROCKETRIDE_CORE_SHARED Text &nodeId(bool verify = true) noexcept;
ROCKETRIDE_CORE_SHARED Paths &paths() noexcept;
ROCKETRIDE_CORE_SHARED util::Vars &vars() noexcept;
ROCKETRIDE_CORE_SHARED Ptr<engine::monitor::Monitor> &monitor() noexcept;

// Loads the optionally parsed json::Value from user.json, this file
// must exist in the working directory, or the executable path (in that order)
// of engine to be loaded properly
ROCKETRIDE_CORE_SHARED const ErrorOr<json::Value> &user() noexcept;

inline bool isPath(iTextView name) noexcept {
    return name == "data" || name == "cache" || name == "control" ||
           name == "log";
}

inline Text expand(TextView str) noexcept { return vars().expand(str); }

}  // namespace engine::config
