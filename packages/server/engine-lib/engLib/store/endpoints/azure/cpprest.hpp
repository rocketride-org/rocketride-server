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

#include <cpprest/http_client.h>

namespace engine::store::filter::azure {

// Forward the xplat macro (we disable the U one explicitly)
#define _w _XPLATSTR

// Short hand to transform a type to a utility string
template <typename T>
inline ::utility::string_t toStr(T&& arg) noexcept {
    if constexpr (traits::IsSameTypeV<T, Text>)
#if ROCKETRIDE_PLAT_WIN
        return ::utility::string_t{_cast<const wchar_t*>(arg)};
#else
        return ::utility::string_t{arg.c_str()};
#endif
    else if constexpr (std::is_constructible_v<::utility::string_t, T>)
        return ::utility::string_t{std::forward<T>(arg)};
    else
        return toStr(_ts(arg));
}

// Short hand to transform a type to a web json value
template <typename T>
inline ::web::json::value toVal(T&& arg) noexcept {
    return ::web::json::value{toStr(arg)};
}

}  // namespace engine::store::filter::azure
