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

// Forward declare Error in the ap space
namespace ap {
class Error;
}  // namespace ap

namespace ap::dev {

template <typename... DebugInfo>
void enterDebugger(Location location, DebugInfo&&... info) noexcept;

template <typename... DebugInfo>
[[noreturn]] void fatality(Location location, DebugInfo&&... info) noexcept;

using FatalityHandler =
    Function<void(Location location, std::string_view reason)>;

[[nodiscard]] size_t registerFatalityHandler(
    FatalityHandler&& handler) noexcept;
void deRegisterFatalityHandler(size_t slot) noexcept;

ROCKETRIDE_CORE_API void onFatality(Location location, std::string_view reason) noexcept;
ROCKETRIDE_CORE_API bool& bugCheck() noexcept;
ROCKETRIDE_CORE_API bool& fatalityExecuting() noexcept;

}  // namespace ap::dev
