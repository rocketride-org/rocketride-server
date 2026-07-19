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

TEST_CASE("crypto::base64") {
    // RFC 4648 section 10 test vectors.
    SUBSECTION("Encodes the RFC 4648 vectors") {
        REQUIRE(crypto::base64Encode(memory::viewCast<uint8_t>(""_tv)) ==
                ""_tv);
        REQUIRE(crypto::base64Encode(memory::viewCast<uint8_t>("f"_tv)) ==
                "Zg=="_tv);
        REQUIRE(crypto::base64Encode(memory::viewCast<uint8_t>("fo"_tv)) ==
                "Zm8="_tv);
        REQUIRE(crypto::base64Encode(memory::viewCast<uint8_t>("foo"_tv)) ==
                "Zm9v"_tv);
        REQUIRE(crypto::base64Encode(memory::viewCast<uint8_t>("foob"_tv)) ==
                "Zm9vYg=="_tv);
        REQUIRE(crypto::base64Encode(memory::viewCast<uint8_t>("fooba"_tv)) ==
                "Zm9vYmE="_tv);
        REQUIRE(crypto::base64Encode(memory::viewCast<uint8_t>("foobar"_tv)) ==
                "Zm9vYmFy"_tv);
    }

    SUBSECTION("Decodes the RFC 4648 vectors") {
        REQUIRE(crypto::base64Decode(""_tv)->empty());
        REQUIRE_VALUE(crypto::base64Decode("Zg=="_tv), "f"_tv);
        REQUIRE_VALUE(crypto::base64Decode("Zm8="_tv), "fo"_tv);
        REQUIRE_VALUE(crypto::base64Decode("Zm9v"_tv), "foo"_tv);
        REQUIRE_VALUE(crypto::base64Decode("Zm9vYg=="_tv), "foob"_tv);
        REQUIRE_VALUE(crypto::base64Decode("Zm9vYmE="_tv), "fooba"_tv);
        REQUIRE_VALUE(crypto::base64Decode("Zm9vYmFy"_tv), "foobar"_tv);
    }

    SUBSECTION("Round trips a longer payload") {
        const auto original = "The quick brown fox jumps over the lazy dog."_tv;
        auto encoded =
            crypto::base64Encode(memory::viewCast<uint8_t>(original));
        REQUIRE_VALUE(crypto::base64Decode(encoded), original);
    }

    SUBSECTION("Decodes unpadded partial groups") {
        // Trailing padding is optional on decode, matching the original.
        REQUIRE_VALUE(crypto::base64Decode("Zg"_tv), "f"_tv);
        REQUIRE_VALUE(crypto::base64Decode("Zm8"_tv), "fo"_tv);
    }

    SUBSECTION("Whitespace or invalid bytes terminate decoding") {
        // Decoding stops at the first byte outside the alphabet (the padding
        // character, whitespace, or anything else), so only the leading valid
        // run is decoded. This preserves the original behavior.
        REQUIRE_VALUE(crypto::base64Decode("Zm9v YmFy"_tv), "foo"_tv);
        REQUIRE_VALUE(crypto::base64Decode("Zm9v\tYmFy"_tv), "foo"_tv);
        REQUIRE_VALUE(crypto::base64Decode("Zm9v*bad"_tv), "foo"_tv);
    }
}
