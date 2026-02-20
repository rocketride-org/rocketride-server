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

// LZ4 api specialization, this is the lowest layer
// of our abstraction
template <>
struct CompApi<Type::LZ4> {
    static size_t deflateBound(size_t len) noexcept {
        return ::LZ4_compressBound(_nc<int>(len));
    }

    template <typename In, typename Out>
    static ErrorOr<size_t> deflate(const In &input, Out &output) noexcept {
        auto in = memory::viewCast<uint8_t>(input);
        output.resize(deflateBound(in.size()));
        auto out = memory::viewCast<uint8_t>(output);

        auto resultSize = ::LZ4_compress_default(
            in.template cast<const char>(), out.template cast<char>(),
            in.template sizeAs<int>(), out.template sizeAs<int>());
        if (resultSize <= 0)
            return APERR(Ec::Lz4Deflate, "Failure compressing");
        output.resize(resultSize);
        return in.size();
    }

    static Error inflate(InputData in, OutputData out) noexcept {
        if (in.empty()) return {};

        if (out.empty())
            return APERR(Ec::InvalidParam, "Output buffer is empty");

        auto expectedSize = out.size();

        auto resultSize =
            ::LZ4_decompress_safe(in.cast<const char>(), out.cast<char>(),
                                  in.sizeAs<int>(), out.sizeAs<int>());
        if (resultSize <= 0 || resultSize != expectedSize)
            return APERR(Ec::Lz4Inflate, "Invalid decompression size",
                         resultSize, "!=", expectedSize);
        return {};
    }
};

}  // namespace ap::compress
