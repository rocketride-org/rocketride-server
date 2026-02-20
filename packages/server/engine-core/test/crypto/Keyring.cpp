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

TEST_CASE("crypto::Keyring") {
    using namespace crypto;

    _const auto hexKey =
        "43326B8C90A8C37A0EE2B3D87580AA413DF843D0BCFED3D6D56160DA5B0039B2"_tv;
    _const auto keyId = "TestKey"_tv;
    const Key key(engineCipher(), hexKey, keyId);

    // Sanity checks on key identifiers
    REQUIRE(key.id() == keyId);
    REQUIRE_FALSE(key.immutableId() == keyId);
    REQUIRE(key.immutableId() == _ts(immutableKeyId(key.keyData())));

    SECTION("Empty keyring") {
        Keyring keyring({});
        REQUIRE(keyring.empty());
        REQUIRE_FALSE(keyring.defaultKeyId());
        REQUIRE_THROWS(*keyring.getKeyById(key.id()));
        REQUIRE_THROWS(*keyring.getKeyByImmutableId(key.immutableId()));

        const auto json = _tj(keyring);
        const auto keyringFromJson = _fj<Keyring>(json);
        REQUIRE(keyringFromJson == keyring);
    }

    SECTION("Keyring with single key") {
        Keyring keyring;
        keyring.addKey(key);
        REQUIRE(!keyring.empty());
        REQUIRE(keyring.defaultKeyId() == key.id());
        REQUIRE(*keyring.getKeyById(key.id()) == key);
        REQUIRE(*keyring.getKeyByImmutableId(key.immutableId()) == key);

        const auto json = _tj(keyring);
        const auto keyringFromJson = _fj<Keyring>(json);
        REQUIRE(keyringFromJson == keyring);
    }

    SECTION("Keyrings with multiple keys") {
        const Key otherKey(
            engineCipher(),
            "DCD1F6F43214D186A8371DDECFED868F221C9EF84F71781C93A9950D1383561B"_tv);

        Keyring keyring1;
        keyring1.addKey(key);
        keyring1.addKey(otherKey);

        Keyring keyring2;
        keyring2.addKey(otherKey);
        keyring2.addKey(key);

        // Different key orders = different keyrings
        REQUIRE(keyring1 != keyring2);
        REQUIRE(keyring1.defaultKeyId() != keyring2.defaultKeyId());

        // Last key is most preferred
        REQUIRE(keyring1.defaultKeyId() == otherKey.id());
        REQUIRE(keyring2.defaultKeyId() == key.id());
    }

    SECTION("Keyring with duplicate keys") {
        Keyring keyring;
        keyring.addKey(key);
        REQUIRE_THROWS(*keyring.addKey(key));
    }
}
