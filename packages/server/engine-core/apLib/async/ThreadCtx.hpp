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

// A thread context represents an actual thread, and it serves
// as a common point of reference for our cancellation state. This
// context begins its like in a Thread object, which once started
// gets places in the started threads 'currentThread' context.
class ThreadCtx : public RunCtx {
public:
    // Give the Thread object access to our internals, and ThreadApi
    // both manipulate the context during thread bootstrap
    friend class Thread;
    friend class ThreadApi;

    // Thread log level
    _const auto LogLevel = Lvl::Thread;

    ThreadCtx(Location location, Variant<Name, TextView, Text> name,
              bool markReady = false) noexcept
        : RunCtx(location, _mv(name)), m_readyFlag(markReady) {}

    ~ThreadCtx() noexcept { m_readyFlag = false; }

    // Handle to this thread, system specific
    SystemTid systemId() const noexcept { return m_systemId; }

    // Access the held thread object
    decltype(auto) thread() noexcept {
        ASSERT(m_thread);
        return m_thread.value();
    }

    bool isReady() const noexcept { return m_readyFlag; }

    // This structure tracks tls held data, we use std::any to store
    // any arbitrary type
    struct TlsData {
        // Location of the allocated tls data
        Location location;

        // Any storage, holding the opaque type
        std::any data;
    };

    // Register tls data with this context to be freed when the thread
    // exits
    template <typename T, typename... Args>
    Ref<T> allocateTlsData(Location location, Args &&...args) noexcept(false) {
        // Add a slot, it will live in our vector member
        auto &slot = m_tlsData.emplace_back();

        // We use a shared ptr just so this constructs, this gets around
        // the requirement that any type must be copyable in the any var
        auto data = makeShared<T>(std::forward<Args>(args)...);
        slot.data = data;
        slot.location = location;
        return *data;
    }

private:
    // Clears held tls data, called by Thread on join
    void clearTlsData() noexcept { m_tlsData.clear(); }

    // This atomic flag is used during thread start as we setup
    Atomic<bool> m_readyFlag = {};

    // Our thread id, this is established when the context is
    // set after a thread starts, by ThreadApi itself, or when the
    // context is implicitly created from a get request to the
    // thread api from an external thread.
    SystemTid m_systemId = {};

    // Optional holder for the std::thread, it is instantiated on a
    // call to start
    Opt<std::thread> m_thread;

    // Collection of opaque thread locally managed data types
    std::vector<TlsData> m_tlsData;
};

}  // namespace ap::async
