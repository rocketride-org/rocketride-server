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

//
//	RocketRide global thread api
//
#pragma once

namespace ap::async {

// Initialize upon instantiation our main thread id
static Tid MainThreadId = threadId();

inline Atomic<bool> &globalCancelFlag() noexcept {
    static Atomic<bool> flag;
    return flag;
}

inline Atomic<time::Duration> &globalCancelFailsafe() noexcept {
    static Atomic<time::Duration> duration{10s};
    return duration;
}

// Sleep for the given duration
inline void sleep(time::Duration wait) noexcept {
    // Do the wait
    std::this_thread::sleep_for(wait.as<time::milliseconds>());
}

// Sleep for the given duration but check for thread cancellation as well
inline bool sleepCheck(time::Duration wait, bool global) noexcept {
    if (cancelled(global)) return true;

    auto start = time::now();
    time::Duration totalWaited;
    _forever() {
        if (totalWaited >= wait) return false;

        if (totalWaited > 5s)
            sleep(100ms);
        else if (totalWaited > 1s)
            sleep(50ms);
        else if (totalWaited > .5s)
            sleep(5ms);
        else if (totalWaited > .1s)
            sleep(1ms);
        else
            yield();

        if (cancelled(global)) return true;

        totalWaited += time::now() - _exch(start, time::now());
    }
}

// Sleep an check and construct error at location
inline Error sleepCheck(Location location, time::Duration wait,
                        bool global) noexcept {
    if (auto ccode = cancelled(location, global)) return ccode;

    auto start = time::now();
    time::Duration totalWaited;
    _forever() {
        if (totalWaited >= wait) return {};

        if (totalWaited > 5s)
            sleep(100ms);
        else if (totalWaited > 1s)
            sleep(50ms);
        else if (totalWaited > .5s)
            sleep(5ms);
        else if (totalWaited > .1s)
            sleep(1ms);
        else
            yield();

        if (auto ccode = cancelled(location, global)) return ccode;

        totalWaited += time::now() - _exch(start, time::now());
    }

    return {};
}

// Yields the time slice of the current thread
inline void yield() noexcept { std::this_thread::yield(); }

inline bool hasCtx() noexcept { return ThreadApi::hasCtx(); }

// Checks if the current thread is cancelled or not
inline Error cancelled(Location location, bool global) noexcept {
    auto ctx = ThreadApi::thisCtx();
    if (ctx && ctx->current()->cancelled())
        return Error{Ec::Cancelled, location, "Thread locally cancelled",
                     ctx->current()->name()};
    if (global && globalCancelFlag()) {
        if (ctx)
            return Error{Ec::Cancelled, location, "Thread globally cancelled",
                         ctx->current()->name()};
        return Error{Ec::Cancelled, location, "Thread globally cancelled"};
    }
    return {};
}

// Checks if the current thread is cancelled or not. This is a faster
// version which does not return an Error, used internally in the thread
// system for efficiency
inline bool cancelled(bool global) noexcept {
    auto ctx = ThreadApi::thisCtx();
    if (ctx && ctx->current()->cancelled()) return true;
    if (global && globalCancelFlag()) return true;
    return false;
}

// Gets the current thread id
inline Tid threadId() noexcept { return std::this_thread::get_id(); }

// Gets the current processId id
inline Pid processId() noexcept {
#if ROCKETRIDE_PLAT_WIN
    return ::GetCurrentProcessId();
#else
    return ::getpid();
#endif
}

inline void setCurrentThreadName(TextView name) noexcept {
    ThreadApi::setName(ThreadApi::thisCtx()->systemId(), name);
}

inline auto getCurrentThreadName() noexcept {
    return ThreadApi::thisCtx()->name();
}

inline bool isMainThread() noexcept { return MainThreadId == threadId(); }

}  // namespace ap::async
