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

#include "test.h"

TEST_CASE("crypto::deriveKeyDataFromPassword") {
    using namespace crypto;
    using namespace crypto::impl;

    auto makeHexKey = [](TextView password, TextView salt, size_t iterations,
                         size_t keyLength) {
        return hexEncode(
            *deriveKeyDataFromPassword(password, salt, iterations, keyLength));
    };

    // Test vectors from
    // https://datatracker.ietf.org/doc/html/draft-josefsson-pbkdf2-test-vectors-06
    REQUIRE(makeHexKey("password", "salt", 1, 20) ==
            "0c60c80f961f0e71f3a9b524af6012062fe037a6");
    REQUIRE(makeHexKey("password", "salt", 2, 20) ==
            "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957");
    REQUIRE(makeHexKey("password", "salt", 4096, 20) ==
            "4b007901b765489abead49d926f721d065a429c1");
    // This test vector takes ~10 seconds to execute due to the iteration count;
    // omitted
    // REQUIRE(makeKey("password", "salt", 16777216, 20) ==
    // "eefe3d61cd4da4e4e9945b3d6ba2158c2634e984");
    REQUIRE(makeHexKey("passwordPASSWORDpassword",
                       "saltSALTsaltSALTsaltSALTsaltSALTsalt", 4096, 25) ==
            "3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038");
    // This test vector uses strings with null characters, which won't work as
    // TextViews; omitted
    // REQUIRE(makeKey("pass\0word", "sa\0lt", 4096, 16) ==
    // "56fa6aa75548099dcc37d7f03425e0c3");
}

TEST_CASE("crypto::deriveKeyDataFromKey") {
    using namespace crypto;
    using namespace crypto::impl;

    auto makeHexKey = [&](size_t keyLength, TextView hexKeyData,
                          TextView hexSalt, TextView hexInfo) {
        auto derived = *deriveKeyDataFromKey(
            EVP_PKEY_HKDEF_MODE_EXTRACT_AND_EXPAND, hexDecode(hexKeyData),
            hexDecode(hexSalt), hexDecode(hexInfo), keyLength);
        return hexEncode(derived);
    };

    // Test vectors from https://datatracker.ietf.org/doc/html/rfc5869
    REQUIRE(makeHexKey(42, "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
                       "000102030405060708090a0b0c", "f0f1f2f3f4f5f6f7f8f9") ==
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34"
            "007208d5b887185865");

    REQUIRE(makeHexKey(82,
                       "000102030405060708090a0b0c0d0e0f101112131415161718191a1"
                       "b1c1d1e1f202122232425262728292a2b2c2d2e2f30313233343536"
                       "3738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f",
                       "606162636465666768696a6b6c6d6e6f707172737475767778797a7"
                       "b7c7d7e7f808182838485868788898a8b8c8d8e8f90919293949596"
                       "9798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
                       "b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cac"
                       "bcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6"
                       "e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff") ==
            "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59"
            "045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30"
            "c58179ec3e87c14c01d5c1f3434f1d87");

    REQUIRE(makeHexKey(42, "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", {},
                       {}) ==
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d"
            "201395faa4b61a96c8");
}