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

#pragma once

namespace ap::async {

// Static class that provides apis to manage the this thread of
// execution
class ThreadApi {
public:
    // Only Thread call setThisCtx when it starts
    friend class Thread;

    // Sets the name of a thread at a given id, this will appear in debuggers.
    // Each platform typically limits the length of a thread name.
    static auto setName(SystemTid id,
                        Variant<ThreadName, TextView> newName) noexcept {
#if defined(ROCKETRIDE_PLAT_WIN)
        // Setup for thread name setting, pulled from MSDN example
#pragma pack(push, 8)
        typedef struct tagTHREADNAME_INFO {
            DWORD dwType;      // Must be 0x1000.
            LPCSTR szName;     // Pointer to name (in user addr space).
            DWORD dwThreadID;  // Thread ID (-1=caller thread).
            DWORD dwFlags;     // Reserved for future use, must be zero.
        } THREADNAME_INFO;
#pragma pack(pop)
        auto setThreadName = [&](const auto &threadName) noexcept {
            THREADNAME_INFO info;
            info.dwType = 0x1000;
            info.szName = &threadName.front();
            info.dwThreadID = ::GetThreadId(id);
            info.dwFlags = 0;
#pragma warning(push)
#pragma warning(disable : 6320 6322)
            __try {
                ::RaiseException(0x406D1388, 0,
                                 sizeof(info) / sizeof(ULONG_PTR),
                                 (ULONG_PTR *)&info);
            } __except (EXCEPTION_EXECUTE_HANDLER) {
            }
#pragma warning(pop)
        };

        _visit(setThreadName, newName);
#elif defined(ROCKETRIDE_PLAT_UNX)
        _visit(
            [&](const auto &threadName) noexcept {
#if ROCKETRIDE_PLAT_MAC
                pthread_setname_np(&threadName.front());
#else
                ::pthread_setname_np(id, &threadName.front());
#endif
            },
            newName);
#endif
    }

    // This function returns a pointer to the this thread context
    static auto thisCtx(TextView name = "External",
                        bool markReady = false) noexcept {
        return _visit(
            overloaded{// Caller of the thread supplied a context ptr on start
                       [](ThreadCtx *ctx) noexcept { return ctx; },
                       // We already implicitly instantiated a thread context
                       [](ThreadCtx &ctx) noexcept { return &ctx; },
                       // No context was set by a spawning thread, implicitly
                       // instantiate one
                       // using the variant to hold it
                       [&](std::monostate) noexcept {
                           return &m_thisCtx.emplace<ThreadCtx>(_location, name,
                                                                markReady);
                       }},
            m_thisCtx);
    }

    static bool hasCtx() noexcept {
        return _visit(
            overloaded{[](ThreadCtx *ctx) noexcept { return ctx->isReady(); },
                       [](ThreadCtx &ctx) noexcept { return ctx.isReady(); },
                       [&](std::monostate) noexcept { return false; }},
            m_thisCtx);
    }

private:
    // Sets the this context ptr, called internally in Thread startup
    static auto setThisCtx(Variant<std::monostate, ThreadCtx *> ctx) noexcept {
        _visit([&](auto &ctx) noexcept { m_thisCtx = ctx; }, ctx);
    }

    // Internal method, called when a thread entry completes
    static auto threadExit() noexcept {
        // Notify this context is going away
        ThreadApi::setThisCtx(nullptr);
    }

    // Internal method, called by the thread on its run entry point
    // at this time we are in the spawned thread, so we can set the
    // native handle
    static decltype(auto) threadEntry(ThreadCtx *ctx) noexcept {
        ctx->m_systemId = _reCast<SystemTid>(ctx->thread().native_handle());
        setThisCtx(ctx);
        setName(ctx->m_systemId, ctx->name());
        return util::Guard{[&]() noexcept { ThreadApi::threadExit(); }};
    }

	// Every thread has a thread context, the context holds the thread
	// name, and its cancellation flag. Thread context live within thread
	// objects. 3rd party threads will get their own context implicitly
	// instantiated if needed.
	// Defined in api.cpp to avoid duplicate thread-local init routines when
	// the header is included in multiple TUs (e.g. classify wrapper + engLib).
	static thread_local Variant<std::monostate, ThreadCtx *, ThreadCtx> m_thisCtx;
};

}  // namespace ap::async
