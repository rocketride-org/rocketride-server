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

//
//	RocketRide global thread api
//
#pragma once

namespace ap::async {

void globalCancel() noexcept;

Atomic<bool> &globalCancelFlag() noexcept;
Atomic<time::Duration> &globalCancelFailsafe() noexcept;

void sleep(time::Duration wait) noexcept;
void yield() noexcept;

[[nodiscard]] bool sleepCheck(time::Duration wait, bool global = true) noexcept;
[[nodiscard]] Error sleepCheck(Location location, time::Duration wait,
                               bool global = true) noexcept;

Error cancelled(Location location, bool global = true) noexcept;
bool cancelled(bool global = true) noexcept;

Tid threadId() noexcept;
Pid processId() noexcept;

void init() noexcept;
void deinit() noexcept;

void setCurrentThreadName(TextView name) noexcept;
bool isMainThread() noexcept;
bool hasCtx() noexcept;

}  // namespace ap::async
