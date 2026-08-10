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

// The context thread holds the thread name, and its cancellation flag.
namespace {
thread_local Variant<std::monostate, ThreadCtx *, ThreadCtx> g_thisCtx = {};
}  // namespace

ThreadCtx *ThreadApi::thisCtx(TextView name, bool markReady) noexcept {
    return _visit(
        overloaded{// Caller of the thread supplied a context ptr on start
                   [](ThreadCtx *ctx) noexcept { return ctx; },
                   // We already implicitly instantiated a thread context
                   [](ThreadCtx &ctx) noexcept { return &ctx; },
                   // No context was set by a spawning thread, implicitly
                   // instantiate one
                   // using the variant to hold it
                   [&](std::monostate) noexcept {
                       return &g_thisCtx.emplace<ThreadCtx>(_location, name,
                                                            markReady);
                   }},
        g_thisCtx);
}

bool ThreadApi::hasCtx() noexcept {
    return _visit(
        overloaded{[](ThreadCtx *ctx) noexcept { return ctx->isReady(); },
                   [](ThreadCtx &ctx) noexcept { return ctx.isReady(); },
                   [&](std::monostate) noexcept { return false; }},
        g_thisCtx);
}

void ThreadApi::setThisCtx(Variant<std::monostate, ThreadCtx *> ctx) noexcept {
    _visit([&](auto &ctx) noexcept { g_thisCtx = ctx; }, ctx);
}

Opt<async::Thread> g_failsafe;

Atomic<bool> &globalCancelFlag() noexcept {
    static Atomic<bool> flag;
    return flag;
}

Atomic<time::Duration> &globalCancelFailsafe() noexcept {
    static Atomic<time::Duration> duration{10s};
    return duration;
}

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
