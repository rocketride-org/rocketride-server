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

// Base64 encoded table, the way this works is, during decode operations
// the offset of each found character is itself a character
_const auto Base64Table =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"_tv;

// Reverse lookup: alphabet character -> 0..63, 0xFF for everything else
// (including '=', whitespace, and any other byte). A single lookup per input
// character then reproduces both the "stop at '='" and "stop at first invalid"
// behavior of the previous double linear scan.
_const auto B64Reverse = [] {
    std::array<uint8_t, 256> table{};
    for (auto &entry : table) entry = 0xFF;
    for (uint8_t i = 0; i < Base64Table.size(); ++i)
        table[_cast<uint8_t>(Base64Table[i])] = i;
    return table;
}();

// Encode a string as a base 64 string
inline Text base64Encode(InputData input) noexcept {
    StackTextArena arena;
    StackText result{arena};

    result.reserve((input.size() + 2) / 3 * 4);

    int i = 0;
    int j = 0;
    unsigned char chr3[3];
    unsigned char chr4[4];

    while (input) {
        ASSERT(i < 3);
        chr3[i++] = *(input++);
        if (i == 3) {
            chr4[0] = (chr3[0] & 0xfc) >> 2;
            chr4[1] = ((chr3[0] & 0x03) << 4) + ((chr3[1] & 0xf0) >> 4);
            chr4[2] = ((chr3[1] & 0x0f) << 2) + ((chr3[2] & 0xc0) >> 6);
            chr4[3] = chr3[2] & 0x3f;

            for (i = 0; i < 4; i++) {
                ASSERTD(chr4[i] < Base64Table.size());
                result += Base64Table[chr4[i]];
            }
            i = 0;
        }
    }

    if (i) {
        for (j = i; j < 3; j++) chr3[j] = '\0';

        chr4[0] = (chr3[0] & 0xfc) >> 2;
        chr4[1] = ((chr3[0] & 0x03) << 4) + ((chr3[1] & 0xf0) >> 4);
        chr4[2] = ((chr3[1] & 0x0f) << 2) + ((chr3[2] & 0xc0) >> 6);

        for (j = 0; (j < i + 1); j++) {
            ASSERTD(chr4[j] < Base64Table.size());
            result += Base64Table[chr4[j]];
        }

        while ((i++ < 3)) result += '=';
    }

    return result;
}

// Decode a string from base64
inline ErrorOr<Buffer> base64Decode(TextView input) noexcept {
    if (!input) return Buffer{};

    int i = 0, j = 0;
    unsigned char chr4[4], chr3[3];

    StackTextArena arena;
    StackText result{arena};

    result.reserve(input.size());

    // A single table lookup replaces the previous double linear scan of the
    // alphabet. The sentinel (0xFF) covers '=', whitespace, and any other
    // non-alphabet byte, so this one check reproduces both the stop-at-'=' and
    // stop-at-first-invalid termination of the original loop.
    while (input) {
        uint8_t value = B64Reverse[_cast<uint8_t>(*input)];
        if (value == 0xFF) break;
        chr4[i++] = value;
        ++input;
        if (i == 4) {
            chr3[0] = (chr4[0] << 2) + ((chr4[1] & 0x30) >> 4);
            chr3[1] = ((chr4[1] & 0xf) << 4) + ((chr4[2] & 0x3c) >> 2);
            chr3[2] = ((chr4[2] & 0x3) << 6) + chr4[3];

            for (i = 0; (i < 3); i++) result += chr3[i];
            i = 0;
        }
    }

    if (i) {
        chr3[0] = (chr4[0] << 2) + ((chr4[1] & 0x30) >> 4);
        chr3[1] = ((chr4[1] & 0xf) << 4) + ((chr4[2] & 0x3c) >> 2);

        for (j = 0; (j < i - 1); j++) result += chr3[j];
    }

    return Buffer(_reCast<const uint8_t *>(result.data()), result.length());
}

}  // namespace ap::crypto
