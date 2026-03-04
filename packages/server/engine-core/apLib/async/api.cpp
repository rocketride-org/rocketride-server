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

namespace ap::async {

// Single definition to avoid duplicate thread-local init symbols when linking
// (e.g. classify wrapper dylib on macOS).
thread_local Variant<std::monostate, ThreadCtx *, ThreadCtx> ThreadApi::m_thisCtx = {};

Opt<async::Thread> g_failsafe;

void globalCancel() noexcept {
    // See if we're first
    if (globalCancelFlag().exchange(true)) {
        LOG(Init, Color::Red, "Global cancel already set, exiting");
        application::quickExit(1);
    }

    if (!globalCancelFailsafe().load()) {
        LOG(Always, Color::Red, "Exiting due to immediate cancel request");
        application::quickExit(1);
    }

    // Ok guarantee an exit within 10 seconds
    g_failsafe.emplace(_location, "Failsafe exit handler", [] {
        LOG(Always, Color::Red, "Cancel request, fail safe in",
            globalCancelFailsafe());

        // Sleep until this thread is cancelled (do not check for global
        // cancel as well, we just set it to true)
        if (async::sleepCheck(globalCancelFailsafe(), false)) return;

        // Timed out, force the issue
        LOG(Always, Color::Red, "Initiating fail safe shutdown");
        application::quickExit(1);
    });
    ASSERTD_MSG(!g_failsafe->start(), "Failed to initiate fail safe shutdown");
}

void init() noexcept {
    // Setup the main thread, note this can't be done globally as tls is
    // not setup at that time
    ThreadApi::thisCtx("Main", true);
}

void deinit() noexcept {
    if (g_failsafe) g_failsafe->stop();
}

}  // namespace ap::async
