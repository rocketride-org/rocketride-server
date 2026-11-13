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

namespace boost {
// ECMA 182 CRC-64 definition
using crc_64_type = crc_optimal<64, 0x42F0E1EBA9EA3693, 0x0, 0x0, false, false>;
}  // namespace boost

namespace ap::crypto {

// Calculate the CRC-32 hash
inline uint32_t crc32(const InputData &data) noexcept {
    boost::crc_32_type crc;
    crc.process_bytes(data.data(), data.size());
    return crc.checksum();
};

// Calculate the ECMA-182 CRC-64 hash
inline uint64_t crc64(const InputData &data) noexcept {
    boost::crc_64_type crc;
    crc.process_bytes(data.data(), data.size());
    return crc.checksum();
};

}  // namespace ap::crypto