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

namespace ap::async {

// The tls class registers thread local storage with our thread context
// allowing us to destroy the thread local data automatically without
// relying on the platform subsystem to do it for us
// @notes
// This class should only be defined statically with the _thread_local
// macros
template <typename T>
class Tls final {
public:
    // No move or copy allowed
    Tls() = delete;
    Tls(const Tls &) = delete;
    Tls(Tls &&) = delete;

    template <typename... Args>
    Tls(Location location, Args &&...args) noexcept(false);

    T *operator->() noexcept;
    const T *operator->() const noexcept;

    T &operator*() noexcept;
    const T &operator*() const noexcept;

    T *operator&() noexcept;
    const T *operator&() const noexcept;

private:
    // Held type reference, actual instance lives in async::ThreadCtx
    Ref<T> m_data;
};

}  // namespace ap::async
