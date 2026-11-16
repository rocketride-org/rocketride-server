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

#include "test.h"

TEST_CASE("crypto::hex") {
    SUBSECTION("Encode is lowercase, zero padded, width two") {
        uint8_t ab[] = {0xAB};
        uint8_t zeroA[] = {0x0A};
        uint8_t ff[] = {0xFF};
        uint8_t zero[] = {0x00};
        REQUIRE(crypto::hexEncode(InputData{ab, 1}) == "ab"_tv);
        REQUIRE(crypto::hexEncode(InputData{zeroA, 1}) == "0a"_tv);
        REQUIRE(crypto::hexEncode(InputData{ff, 1}) == "ff"_tv);
        REQUIRE(crypto::hexEncode(InputData{zero, 1}) == "00"_tv);

        uint8_t bytes[] = {0x00, 0x01, 0x0f, 0x10, 0xab, 0xcd, 0xef};
        REQUIRE(crypto::hexEncode(InputData{bytes, sizeof(bytes)}) ==
                "00010f10abcdef"_tv);
    }

    SUBSECTION("Decode yields the expected bytes, case-insensitive") {
        REQUIRE(crypto::hexDecode("6162"_tv) == "ab"_tv);
        REQUIRE(crypto::hexDecode("4142"_tv) == "AB"_tv);
        // Upper and lower case hex digits decode identically.
        REQUIRE(crypto::hexDecode("CECE"_tv) == crypto::hexDecode("cece"_tv));
    }

    SUBSECTION("Round trips through both directions") {
        const auto original = "The quick brown fox"_tv;
        auto encoded = crypto::hexEncode(memory::viewCast<uint8_t>(original));
        REQUIRE(crypto::hexDecode(encoded) == original);
    }

    SUBSECTION("Empty input yields empty output both directions") {
        REQUIRE(crypto::hexEncode(InputData{}).empty());
        REQUIRE(crypto::hexDecode(""_tv).empty());
    }

    SUBSECTION("Odd length decodes floor(len/2) bytes without overflow") {
        // Regression guard for the previous one-byte heap overflow: an odd
        // length input must decode only the complete leading pairs and never
        // read past the end of the source.
        auto decoded = crypto::hexDecode("6162a"_tv);  // 5 chars -> 2 bytes
        REQUIRE(decoded.size() == 2);
        REQUIRE(decoded == "ab"_tv);
        REQUIRE(crypto::hexDecode("a"_tv).empty());  // 1 char -> 0 bytes
    }

    SUBSECTION("Invalid characters follow the break-on-invalid semantics") {
        // A bad high nibble yields 0; a bad low nibble keeps the high nibble.
        REQUIRE(crypto::hexDecode("zz"_tv) == crypto::hexDecode("00"_tv));
        REQUIRE(crypto::hexDecode("az"_tv) == crypto::hexDecode("0a"_tv));
    }
}
