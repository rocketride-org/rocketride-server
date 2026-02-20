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

// Wrapper class for handling an std::thread, will join on destruction
// and will not start on construction implicitly
class Thread final {
public:
    // Thread log level
    _const auto LogLevel = Lvl::Thread;

    // Allow move, this is accomplished by use of the ThreadCtx
    // ptr, and our Callback holding a ptr to the captured args.
    Thread(Thread &&thread) = default;
    Thread &operator=(Thread &&thread) = default;

    // Construct from a location and a name but without a callback
    // this requires a start to provide the info
    Thread(Location location, TextView name) noexcept
        : m_ctx(makeUnique<ThreadCtx>(location, name)) {}

    // This constructor mirrors std::threads constructor, takes
    // a function and arguments to bind to the call once started, however
    // unlike std::thread, this thread will not auto start upon
    // construction.
    template <typename Function, typename... Args>
    Thread(Location location, TextView name, Function &&func,
           Args &&...args) noexcept
        : m_callback(std::forward<Function>(func), std::forward<Args>(args)...),
          m_ctx(makeUnique<ThreadCtx>(location, name)) {}

    // Destructor joins on the thread to ensure its lifetime remains
    // bound to this class
    ~Thread() noexcept {
        cancel();
        join();
    }

    // Applies a new callback, then starts the thread
    template <typename Function, typename... Args>
    Error start(Function &&func, Args &&...args) noexcept {
        stop();
        m_callback =
            Callback{std::forward<Function>(func), std::forward<Args>(args)...};
        return start();
    }

    // Starts the thread, if it is running already it will get stopped.
    Error start() noexcept {
        ASSERT(m_ctx);
        stop();

        m_ctx->cancel(false);

        // Wrap the emplacement in a call, it can throw when resources
        // run out
        auto res = error::call(m_ctx->location(), [&] {
            m_ctx->m_thread.emplace(Thread::run, m_ctx.get(),
                                    m_callback.invoker());
        });
        if (res.hasCcode()) return res.ccode();

        // Say we are done setting up
        m_ctx->m_readyFlag = true;
        return {};
    }

    // Blocks until the thread completes
    Error join() noexcept {
        // Null op if in an invalid state or was moved
        if (!m_ctx || !m_ctx->m_thread || !m_ctx->thread().joinable())
            return {};

        // Join, this can throw so, trap it here
        if (auto res =
                error::call(m_ctx->location(), [&] { m_ctx->thread().join(); });
            res.hasCcode())
            m_ctx->m_ccode = res.ccode();

        // Now that the threads done for, clear its tls data if it used any
        m_ctx->clearTlsData();

        // And return and move the held ccode out of the way to reset for next
        // start
        return _mv(m_ctx->m_ccode);
    }

    // Sets the cancel flag, then joins on the thread
    Error stop() noexcept {
        if (!m_ctx) return {};
        cancel();
        auto ccode = join();
        m_ctx->m_readyFlag = false;
        m_ctx->m_thread.reset();
        return ccode;
    }

    // Flags the thread for cancellation
    void cancel() noexcept {
        if (m_ctx) m_ctx->cancel();
    }

    // Checks if this thread is running
    bool running() const noexcept {
        return m_ctx && m_ctx->m_thread && m_ctx->thread().joinable();
    }

    // Explicit boolean cast to check if thread running
    explicit operator bool() const noexcept { return running(); }

    // Returns the id of the thread, may only be called if active
    auto id() const noexcept {
        ASSERT(m_ctx->m_thread);
        return m_ctx->thread().get_id();
    }

    // Returns the name of this thread
    auto name() const noexcept {
        ASSERT(m_ctx);
        return m_ctx->name();
    }

    // Sets the name of this thread, using the context ptr to communicate
    // with the thread process itself
    auto setName(TextView name) noexcept {
        ASSERT(m_ctx);
        return m_ctx->setName(name);
    }

    // Checks if this thread is cancelled
    bool cancelled() const noexcept {
        ASSERT(m_ctx);
        return m_ctx->cancelled();
    }

    // Renders the name of this thread
    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        if (!m_ctx) return _tsb(buff, "{moved}");
        if (!m_ctx->m_thread) return _tsb(buff, m_ctx->name());
        return _tsbo(buff, Format::HEX | Format::PREFIX, id(), ":", name());
    }

    // Gets the location this thread was instantiated at
    auto location() const noexcept {
        ASSERT(m_ctx);
        return m_ctx->location();
    }

private:
    // Internal run method, sets up the context and executes the callback.
    // This is a static method so that we can support move of our thread
    // object regardless of whether it is running or not. We do this by
    // passing the internal invoker in the Callback when binding the
    // thread function
    static void run(ThreadCtx *ctx, Callback::InvokerPtr invoker) noexcept {
        // Now that we know our system id, set it, and to prevent a race here
        // wait for the submitter to confirm they are done emplacing the
        // thread object
        while (!ctx->m_readyFlag) async::yield();
        auto threadScope = ThreadApi::threadEntry(ctx);

        // Do the invoke, execute the thread, pass the location of the callers
        // context
        ctx->m_ccode = invoker->invoke(ctx->location());

        // Free tls data now, this is important, we want tls to destruct on the
        // same thread they were born on
        ctx->clearTlsData();
    }

    // Our thread context, its a ptr so we can move the thread
    // without losing our this reference.
    UniquePtr<ThreadCtx> m_ctx;

    // Bound callback for execution
    Callback m_callback;
};

}  // namespace ap::async
