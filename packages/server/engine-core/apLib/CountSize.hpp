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

// Helper class to abstract a pair of info items, a count and a size
struct CountSize {
    explicit operator bool() const noexcept {
        return _cast<bool>(size) || _cast<bool>(count);
    }

    decltype(auto) operator+=(const CountSize& other) noexcept {
        if (this == &other) return *this;
        size += other.size;
        count += other.count;
        return *this;
    }

    decltype(auto) operator=(const CountSize& other) noexcept {
        if (this == &other) return *this;
        count = other.count;
        size = other.size;
        return *this;
    }

    bool operator<(const CountSize& other) const noexcept {
        return count < other.count || size < other.size;
    }

    bool operator<=(const CountSize& other) const noexcept {
        return count <= other.count || size <= other.size;
    }

    auto reset() noexcept {
        size = {};
        count = {};
    }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        return _tsb(buff, count, "[", size, "]");
    }

    Count count;
    Size size;
};

}  // namespace ap
