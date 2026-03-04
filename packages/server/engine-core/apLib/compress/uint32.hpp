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

namespace ap::compress {

// Integer compression api
template <>
struct CompApi<Type::UINT32> {
    using IntType = uint32_t;
    _const auto IntSize = sizeof(IntType);

    static size_t deflateBound(size_t len) noexcept {
        return len * (IntSize + 1);
    }

    template <typename Allocator = std::allocator<uint8_t>>
    static ErrorOr<size_t> deflate(
        memory::DataView<const uint32_t> in,
        memory::Data<uint8_t, Allocator> &out) noexcept {
        out.resize(deflateBound(in.size()));

        auto iter = out.begin();

        for (auto num : in) {
            //      0x0000:0000 - 0x0000:007F       1 byte      127
            //      0x0000:0080 - 0x0000:3FFF       2 bytes     16,384
            //      0x0000:4000 - 0x001F:FFFF       3 bytes     2,097,151
            //      0x0020:0000 - 0x0FFF:FFFF       4 bytes     268,435,455
            //      0x1000:0000 - 0xFFFF:FFFF       5 bytes     4 billion
            //
            //  The most significant bit is 1 if there is a continuation byte
            //  after the current byte, or 0 if this is the end of the
            //  sequence. Therfore, each byte in the output stream contains
            //  7 significant bits
            if (num <= 0x0000007F) {
                // 1 byte sequence
                //      <0xxx:xxxx>     bits 0-7
                *iter++ = _cast<uint8_t>(num);
            } else if (num <= 0x00003FFF) {
                // 2 byte sequence
                //      <1xxx:xxxx>     bits 8-14
                //      <0xxx:xxxx>     bits 0-7
                *iter++ = 0x80 | _cast<uint8_t>(((num >> 7) & 0x7F));
                *iter++ = _cast<uint8_t>((num & 0x7F));
            } else if (num <= 0x001FFFFF) {
                // 3 byte sequence
                //      <1xxx:xxxx>     bits 15-21
                //      <1xxx:xxxx>     bits 8-14
                //      <0xxx:xxxx>     bits 0-7
                *iter++ = 0x80 | _cast<uint8_t>(((num >> 14) & 0x7F));
                *iter++ = 0x80 | _cast<uint8_t>(((num >> 7) & 0x7F));
                *iter++ = _cast<uint8_t>((num & 0x7F));
            } else if (num <= 0x001FFFFF) {
                // 4 byte sequence
                //      <1xxx:xxxx>     bits 22-28
                //      <1xxx:xxxx>     bits 15-21
                //      <1xxx:xxxx>     bits 8-14
                //      <0xxx:xxxx>     bits 0-7
                *iter++ = 0x80 | _cast<uint8_t>((num >> 21) & 0x7F);
                *iter++ = 0x80 | _cast<uint8_t>((num >> 14) & 0x7F);
                *iter++ = 0x80 | _cast<uint8_t>((num >> 7) & 0x7F);
                *iter++ = _cast<uint8_t>((num & 0x7F));
            } else {
                // 5 byte sequence
                //      <1000:xxxx>     bits 29-32
                //      <1xxx:xxxx>     bits 22-28
                //      <1xxx:xxxx>     bits 15-21
                //      <1xxx:xxxx>     bits 8-14
                //      <0xxx:xxxx>     bits 0-7
                *iter++ = 0x80 | _cast<uint8_t>((num >> 28) & 0x7F);
                *iter++ = 0x80 | _cast<uint8_t>((num >> 21) & 0x7F);
                *iter++ = 0x80 | _cast<uint8_t>((num >> 14) & 0x7F);
                *iter++ = 0x80 | _cast<uint8_t>((num >> 7) & 0x7F);
                *iter++ = _cast<uint8_t>(num & 0x7F);
            }
        }

        out.resize(std::distance(out.begin(), iter));
        return in.size();
    }

    template <typename Allocator = std::allocator<uint32_t>>
    static Error inflate(InputData in,
                         memory::Data<uint32_t, Allocator> &out) noexcept {
        if (in.empty()) return {};

        if (out.empty())
            return APERR(Ec::InvalidParam, "Output buffer is empty");

        auto iter = out.begin();

        uint32_t accum = {};
        for (auto chr : in) {
            // Add it in to the accumulator
            accum = (accum << 7) | (chr & 0x7F);

            // If this is the ending byte, save the accum which is the
            // word id
            if (chr < 0x80) {
                if (iter == out.end())
                    return APERR(Ec::Overflow,
                                 "Ran out of room decompressing uint32");
                *iter++ = _exch(accum, 0);
            }
        }

        return {};
    }
};

}  // namespace ap::compress
