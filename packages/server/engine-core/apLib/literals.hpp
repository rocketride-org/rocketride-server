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

namespace ap {

// Size literals
constexpr Size operator"" _tb(long double count) noexcept {
    return Size::terabytes(count);
}
constexpr Size operator"" _gb(long double count) noexcept {
    return Size::gigabytes(count);
}
constexpr Size operator"" _mb(long double count) noexcept {
    return Size::megabytes(count);
}
constexpr Size operator"" _kb(long double count) noexcept {
    return Size::kilobytes(count);
}
constexpr Size operator"" _b(long double count) noexcept {
    return Size::bytes(count);
}
constexpr Size operator"" _tb(unsigned long long count) noexcept {
    return Size::kTerabyte * count;
}
constexpr Size operator"" _gb(unsigned long long count) noexcept {
    return Size::kGigabyte * count;
}
constexpr Size operator"" _mb(unsigned long long count) noexcept {
    return Size::kMegabyte * count;
}
constexpr Size operator"" _kb(unsigned long long count) noexcept {
    return Size::kKilobyte * count;
}
constexpr Size operator"" _b(unsigned long long count) noexcept {
    return count;
}

// Url literals
inline Url operator"" _url(const char* str, std::size_t count) noexcept {
    return {TextView{str, count}};
}

}  // namespace ap
