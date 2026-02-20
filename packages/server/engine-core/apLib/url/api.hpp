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

namespace ap::url {
//-------------------------------------------------------------------------
///	@details
///		Encode a url component to comply with www standards
///	@param[in]	src
///		The component to encode
//-------------------------------------------------------------------------
inline Text encode(TextView src) noexcept {
    // Get the hex chr
    auto to_hex = [&](unsigned char x) -> unsigned char {
        return x + (x > 9 ? ('A' - 10) : '0');
    };

    // Get a buffer and reserve some space
    Text encoded;
    encoded.reserve(src.length() * 2);

    // Walk through the characters
    for (auto ci = src.begin(); ci != src.end(); ++ci) {
        if ((*ci >= 'a' && *ci <= 'z') || (*ci >= 'A' && *ci <= 'Z') ||
            (*ci >= '0' && *ci <= '9')) {
            encoded += *ci;
        } else if (*ci == ' ') {
            encoded += '+';
        } else {
            encoded += '%';
            encoded += to_hex(*ci >> 4);
            encoded += to_hex(*ci % 16);
        }
    }

    // Return the encoded string
    return encoded;
}

//-------------------------------------------------------------------------
///	@details
///		Decode a url component to comply with www standards
///	@param[in]	src
///		The component to decode
//-------------------------------------------------------------------------
inline Text decode(TextView src) noexcept {
    // Get the hex chr
    auto from_hex = [&](unsigned char ch) -> unsigned char {
        if (ch <= '9' && ch >= '0')
            ch -= '0';
        else if (ch <= 'f' && ch >= 'a')
            ch -= 'a' - 10;
        else if (ch <= 'F' && ch >= 'A')
            ch -= 'A' - 10;
        else
            ch = 0;
        return ch;
    };

    // Loop through the string
    Text decoded;
    for (auto i = 0u; i < src.size(); ++i) {
        if (src[i] == '+') {
            decoded += ' ';
        } else if (src[i] == '%' && src.size() > i + 2) {
            const unsigned char ch1 = from_hex(src[i + 1]);
            const unsigned char ch2 = from_hex(src[i + 2]);
            const unsigned char ch = (ch1 << 4) | ch2;
            decoded += ch;
            i += 2;
        } else {
            decoded += src[i];
        }
    }
    return decoded;
}

}  // namespace ap::url