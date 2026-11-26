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

namespace ap::error {
// Blocks an exception from being raised and returns a
// Error if one was caught, otherwise it returns the
// original return value from the callback called
template <typename Call, typename... Args>
inline auto call(Location location, Call &&call, Args &&...args) noexcept {
    auto processResult = [&](auto ccode) noexcept {
        if constexpr (std::is_void_v<
                          typename std::invoke_result_t<Call, Args...>>)
            return ErrorOr<void>{_mv(ccode)};
        else if constexpr (::ap::traits::IsErrorV<
                               typename std::invoke_result_t<Call, Args...>>)
            return ErrorOr<void>{_mv(ccode)};
        else if constexpr (::ap::traits::IsErrorOrV<
                               typename std::invoke_result_t<Call, Args...>>)
            return typename std::invoke_result_t<Call, Args...>(_mv(ccode));
        else
            return ErrorOr<typename std::invoke_result_t<Call, Args...>>{
                _mv(ccode)};
    };

    try {
        if constexpr (std::is_void_v<
                          typename std::invoke_result_t<Call, Args...>>)
            return std::invoke(std::forward<Call>(call),
                               std::forward<Args>(args)...),
                   ErrorOr<void>{};
        else if constexpr (::ap::traits::IsErrorV<
                               typename std::invoke_result_t<Call, Args...>>)
            return ErrorOr<void>{std::invoke(std::forward<Call>(call),
                                             std::forward<Args>(args)...)};
        else if constexpr (::ap::traits::IsErrorOrV<
                               typename std::invoke_result_t<Call, Args...>>)
            return std::invoke(std::forward<Call>(call),
                               std::forward<Args>(args)...);
        else
            return ErrorOr<typename std::invoke_result_t<Call, Args...>>{
                std::invoke(std::forward<Call>(call),
                            std::forward<Args>(args)...)};
    } catch (const Error &e) {
        return processResult(e);
    } catch (const std::exception &e) {
        return processResult(Error{Ec::Exception, location, e});
    }
}

template <typename Call, typename... Args>
inline Error callCheck(Location location, Call &&cb, Args &&...args) noexcept {
    if (auto res =
            call(location, std::forward<Call>(cb), std::forward<Args>(args)...);
        res.hasCcode())
        return _mv(res).ccode();
    return {};
}

#define _call(...) ::ap::error::call(_location, __VA_ARGS__)
#define _callChk(...) ::ap::error::callCheck(_location, __VA_ARGS__)

}  // namespace ap::error
