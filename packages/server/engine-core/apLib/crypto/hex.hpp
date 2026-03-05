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

// Decode a hex input string to a binary string
inline Buffer hexDecode(TextView input) noexcept {
    if (!input) return {};

    Buffer result;
    result.resize(input.length() / 2);
    static_assert(sizeof(char) == sizeof(uint8_t));
    auto buffer{_reCast<uint8_t *>(result.data())};
    for (size_t pos{}; pos < input.length(); pos += 2)
        buffer[pos >> 1] = _fsh<uint8_t>(input.substr(pos, 2));
    return result;
}

// Encode binary data to a hex string
inline Text hexEncode(InputData input) noexcept {
    if (!input) return {};

    auto bytes{input.byteSize()};
    auto ptr{_reCast<const uint8_t *>(input.data())};

    Text result;
    result.reserve(bytes * 2);

    for (size_t count{}; count < bytes; ++count, ++ptr) {
        result += string::format("{,X`,2}", *ptr);
    }
    return result;
}

inline bool isHexEncoded(TextView text) noexcept { return string::isHex(text); }

}  // namespace ap::crypto
