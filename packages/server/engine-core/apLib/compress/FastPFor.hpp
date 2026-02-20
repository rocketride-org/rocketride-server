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

namespace ap::compress {

// Integer compression api
template <>
struct CompApi<Type::FASTPFOR> {
    using IntType = uint32_t;
    _const auto IntSize = sizeof(IntType);

    static size_t deflateBound(size_t len) noexcept { return len + 1024; }

    template <typename Allocator = std::allocator<uint32_t>>
    static ErrorOr<size_t> deflate(
        memory::DataView<const uint32_t> in,
        std::vector<uint32_t, Allocator> &out) noexcept {
        out.resize(deflateBound(in.size()));

        auto compressedSize = out.size();
        FastPFor::encode(in.data(), in.size(), out.data(), compressedSize);

        out.resize(compressedSize);
        return in.size();
    }

    template <typename Allocator = std::allocator<uint32_t>>
    static ErrorOr<size_t> deflate(
        memory::DataView<const uint32_t> in,
        memory::Data<uint32_t, Allocator> &out) noexcept {
        out.resize(deflateBound(in.size()));

        auto compressedSize = out.size();
        FastPFor::encode(in.data(), in.size(), out, compressedSize);

        out.resize(compressedSize);
        return in.size();
    }

    static Error inflate(memory::DataView<const uint32_t> in,
                         memory::DataView<uint32_t> out) noexcept {
        if (in.empty()) return {};

        if (out.empty())
            return APERRL(Compress, Ec::InvalidParam, "Output buffer is empty");

        auto recoveredSize = out.size();
        FastPFor::decode(in, in.size(), out, recoveredSize);

        return {};
    }
};

}  // namespace ap::compress
