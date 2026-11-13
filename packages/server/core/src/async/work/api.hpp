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

namespace ap::async::work {

// Submits a callback with args to executed asynchronously in the
// custom executor instance
template <typename Cb, typename... Args>
inline ErrorOr<Item> submit(Executor &executor, Location location, Text name,
                            Cb cb, Args &&...args) noexcept {
    return executor.submit(
        location, _mv(name),
        Callback::makeCopy(_mv(cb), std::forward<Args>(args)...));
}

template <typename Cb, typename... Args>
inline ErrorOr<Item> submitRef(Executor &executor, Location location, Text name,
                               Cb cb, Args &&...args) noexcept {
    return executor.submit(location, _mv(name),
                           Callback{_mv(cb), std::forward<Args>(args)...});
}

// Submits a callback with args to executed asynchronously in the
// global executor instance
template <typename Cb, typename... Args>
inline ErrorOr<Item> submit(Location location, Text name, Cb cb,
                            Args &&...args) noexcept {
    return globalExecutor().submit(
        location, _mv(name),
        Callback::makeCopy(_mv(cb), std::forward<Args>(args)...));
}

template <typename Cb, typename... Args>
inline ErrorOr<Item> submitRef(Location location, Text name, Cb cb,
                               Args &&...args) noexcept {
    return globalExecutor().submit(
        location, _mv(name), Callback{_mv(cb), std::forward<Args>(args)...});
}

}  // namespace ap::async::work
