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
#include <signal.h>
namespace ap::application::signal {

namespace {

// When a signal is encountered this gets set and the condition is signalled
int g_pending{};
async::MutexLock g_lock;
async::Condition g_cond;

// Listener thread context
std::optional<async::Thread> g_listener;

// List of signals to intercept not including every single one of them
_const std::array SigList = {
    // Termination request signal
    SIGTERM,

    // Critical signals
    SIGFPE, SIGILL, SIGSEGV, SIGBUS, SIGABRT,

    // Non critical signals
    SIGINT, SIGQUIT, SIGHUP};

void signalHandler(int signal) noexcept {
    auto guard = g_lock.acquire();
    g_pending = signal;
    g_cond.notifyAll(guard);
}

// Setup all the signal handlers
void enableHandler() noexcept {
    // Setup sigaction object
    struct sigaction sigact;
    sigact.sa_handler = signalHandler;
    sigact.sa_flags = 0;

    // Register handler for all signals we are intercepting
    sigemptyset(&sigact.sa_mask);
    for (auto sig : SigList) sigaddset(&sigact.sa_mask, sig);
    for (auto sig : SigList) sigaction(sig, &sigact, nullptr);
}

// De-registers the signal handler
void disableHandler() noexcept {
    for (auto sig : SigList) ::signal(sig, SIG_DFL);
}

// Signal handler for Linux.
void processSignal(int signal) noexcept {
    // Log the signal details
    LOG(Always, "Application received system signal: {}: {} ({})",
        plat::renderSignal(signal), plat::renderSignalDescription(signal),
        signal);

    // Handle non-terminal signals
    switch (signal) {
        case SIGHUP:
            // Hups are allowed, ignore for now
            return;

        case SIGTERM:
        case SIGQUIT:
        case SIGINT:
            // Initiate global cancel, second time will force exit
            async::globalCancel();
            return;
    }

    // Finally, exit
    dev::fatality(_location, "Received terminal system signal");
}

// A thread which watches for a signal to be set, and calls the
// signal handler api so that we can do things like malloc etc.
void listener() noexcept {
    // For the life of the listener keep the handler enabled
    auto guard = util::Guard{enableHandler, disableHandler};

    while (!async::cancelled(false)) {
        auto guard = g_lock.acquire();
        g_cond.wait(guard, [&] { return g_pending; }, {}, false);
        if (auto signal = _exch(g_pending, 0)) processSignal(signal);
    }
}

}  // namespace

void deinit() noexcept;

void init() noexcept {
    // Ignore SIGPIPE
    ::signal(SIGPIPE, SIG_IGN);

    ASSERTD_MSG(!g_listener, "Signals already initialized");
    g_listener.emplace(_location, "Signal Listener", listener);
    ASSERTD_MSG(!g_listener->start(), "Failed to start signal listener");

    // listener() will not quit if deinit() is not called (it may happen in some
    // cases), so lets ensure deinit() call in any case
    std::atexit(deinit);
}

void deinit() noexcept {
    auto guard = g_lock.acquire();
    if (!g_listener->running()) return;
    g_listener->cancel();
    g_cond.notifyAll(guard);
    guard = {};
    g_listener->stop();
}

}  // namespace ap::application::signal
