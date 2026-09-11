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

namespace ap::crypto {

// Lowercase hex digits, matching the literal used in packNumber.hpp so encoded
// output stays byte-for-byte identical to the previous string::format path.
_const char HexLower[] = "0123456789abcdef";

// Reverse lookup: hex character -> nibble value, 0xFF for anything that is
// not a hex digit. Case-insensitive (a-f and A-F) to match the previous _fsh.
_const auto HexReverse = [] {
    std::array<uint8_t, 256> table{};
    for (auto &entry : table) entry = 0xFF;
    for (uint8_t i = 0; i < 10; ++i) table[_cast<size_t>('0') + i] = i;
    for (uint8_t i = 0; i < 6; ++i) {
        table[_cast<size_t>('a') + i] = 10 + i;
        table[_cast<size_t>('A') + i] = 10 + i;
    }
    return table;
}();

// Decode a hex input string to a binary string. Only complete two-character
// pairs are decoded, so an odd-length input yields floor(len/2) bytes and never
// reads past the end of the buffer.
inline Buffer hexDecode(TextView input) noexcept {
    if (!input) return {};

    auto pairs{input.length() / 2};

    Buffer result;
    result.resize(pairs);
    static_assert(sizeof(char) == sizeof(uint8_t));
    auto buffer{_reCast<uint8_t *>(result.data())};
    auto src{_reCast<const uint8_t *>(input.data())};

    // Mirror the accumulate-and-break-on-invalid behavior of the previous _fsh
    // decode for a two-character field: an invalid high nibble yields 0, an
    // invalid low nibble keeps the high nibble on its own.
    for (size_t i{}; i < pairs; ++i) {
        auto hi{HexReverse[src[i * 2]]};
        auto lo{HexReverse[src[i * 2 + 1]]};
        if (hi == 0xFF)
            buffer[i] = 0;
        else if (lo == 0xFF)
            buffer[i] = hi;
        else
            buffer[i] = _cast<uint8_t>((hi << 4) | lo);
    }
    return result;
}

// Encode binary data to a lowercase hex string
inline Text hexEncode(InputData input) noexcept {
    if (!input) return {};

    auto bytes{input.byteSize()};
    auto ptr{_reCast<const uint8_t *>(input.data())};

    Text result;
    result.reserve(bytes * 2);

    for (size_t count{}; count < bytes; ++count, ++ptr) {
        result += HexLower[*ptr >> 4];
        result += HexLower[*ptr & 0x0F];
    }
    return result;
}

inline bool isHexEncoded(TextView text) noexcept { return string::isHex(text); }

}  // namespace ap::crypto
