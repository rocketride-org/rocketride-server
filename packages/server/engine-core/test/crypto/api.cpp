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

TEST_CASE("crypto::lastError") {
    // No error should be set for this thread
    REQUIRE(ERR_peek_last_error() == 0);

    // Set an error for this thread
    const auto ec = 0xff;
    ERR_put_error(1, 0, ec, nullptr, 0);

    // Verify error set and contains expected error code
    const auto error = crypto::lastError();
    REQUIRE(error.contains(_ts(ec)));
}

// Test encryption and decryption of data with embedded IV and key ID
TEST_CASE("crypto::embedAndEncrypt") {
    using namespace ap::crypto;

    auto logScope = ap::test::enableTestLogging(Lvl::Crypto);

    const auto masterKeyHexId = "fc94c0b1bda04a789a81a33deb2df843"_tv;
    const auto masterKeyId = hexDecode(masterKeyHexId);
    const auto masterHexKey =
        "1b2e6696a1504a14aba0c5f3141525912af80669092a4b7cbf4c53418cb2f554"_tv;
    const Cipher masterCipher("aes-256-cbc");
    const Key masterKey(masterCipher, masterHexKey);

    LOG(Test, "MasterKeyId: {}\n MasterCypher: {}\n MasterKey: {}\n",
        masterKeyHexId, masterCipher, masterKey);

    auto keyId1{"fc94c0b1bda04a789a81a33deb2df843"_tv};
    auto encrypt1{
        "/JTAsb2gSniagaM96y34Q2ly6EdkoUNYt9Sj6gY2skfhcZ5k99udmSFPR3hCZbAlmTbce9moO7Z+tVRpN/gk7XVXH/QCmT2tt08s7yY+TGw="_tv};
    auto decrypt1{"{\"user\":\"John Doe\",\"password\":\"sky IS * blue!\"}"_tv};

    LOG(Test, "keyId1: {}\n encrypt1: {}\n decrypt1: {}\n", keyId1, encrypt1,
        decrypt1);

    auto keyId2{"fc94c0b1bda04a789a81a33deb2df843"_tv};
    auto encrypt2{
        "/JTAsb2gSniagaM96y34Q5vozie+dH6N7KW3b0OQgi3hrA+dwp8X5UIFVIbPXpPmNqxlEJFLPYS2OXQMc3dNc1phNgPylleIM295T6t7oDaiCE3UI0DqQZ/ovdtcVM+jOMD7vha0QmaJb/ilIoufOnyaL6xPPpSqGudpVQ01tgZ0GkzdyPHfyODEoPHYHIRK"_tv};
    auto decrypt2{
        "\"Two things are infinite: the universe and human stupidity; and I'm not sure about the universe.\""_tv};

    LOG(Test, "keyId2: {}\n encrypt2: {}\n decrypt2: {}\n", keyId2, encrypt2,
        decrypt2);

    auto decryptCheck{[&](TextView keyId, TextView encrypted,
                          TextView decrypted) noexcept(false) {
        static_assert(sizeof(Uuid::UnderlyingType) == 16);
        REQUIRE(keyId.length() == sizeof(Uuid::UnderlyingType) * 2);

        auto blob{*base64Decode(encrypted)};

        auto rawGuid{hexDecode(keyId)};
        REQUIRE(blob.size() > rawGuid.size());

        REQUIRE(rawGuid.size() == sizeof(Uuid::UnderlyingType));

        auto decryptedData{*extractAndDecrypt(blob, masterKey, masterKeyId)};

        LOG(Test, "Encrypted base64", encrypted);
        LOG(Test, "Decrypted", decryptedData);

        REQUIRE(decryptedData == decrypted);
    }};

    auto encryptThenDecrypt{[&](TextView keyId,
                                TextView decrypted) noexcept(false) {
        auto newEncryption{*embedAndEncrypt(decrypted, masterKey, masterKeyId)};
        auto finalAsBase64{base64Encode(newEncryption)};

        LOG(Test, "Input", decrypted);
        LOG(Test, "Converted to base64", finalAsBase64);

        decryptCheck(keyId, finalAsBase64, decrypted);
    }};

    encryptThenDecrypt(keyId1, decrypt1);
    encryptThenDecrypt(keyId2, decrypt2);

    decryptCheck(keyId1, encrypt1, decrypt1);
    decryptCheck(keyId2, encrypt2, decrypt2);
}
