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

// Constructor for the tls type, constructs the type in the platform
// tls area and registers it with the current thread context for
// deletion when the thread exits
template <typename T>
template <typename... Args>
inline Tls<T>::Tls(Location location, Args &&...args) noexcept(false)
    : m_data(ThreadApi::thisCtx()->template allocateTlsData<T>(
          location, std::forward<Args>(args)...)) {}

// Casting operator casts to the callers type
template <typename T>
inline T &Tls<T>::operator*() noexcept {
    return m_data.get();
}

template <typename T>
inline const T &Tls<T>::operator*() const noexcept {
    return m_data.get();
}

// Deref operator accesses the held type as a ptr
template <typename T>
inline T *Tls<T>::operator->() noexcept {
    return &m_data.get();
}

template <typename T>
inline const T *Tls<T>::operator->() const noexcept {
    return &m_data.get();
}

// Address-of operator; accesses the held type as a ptr
template <typename T>
inline T *Tls<T>::operator&() noexcept {
    return &m_data.get();
}

template <typename T>
inline const T *Tls<T>::operator&() const noexcept {
    return &m_data.get();
}

}  // namespace ap::async
