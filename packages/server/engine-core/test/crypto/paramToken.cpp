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

namespace {

_const auto Plaintext =
    R"({"apikey":"example-api-key","password":"example-password"})"_tv;  // gitleaks:allow
_const auto Secret = "example-param-token-secret"_tv;
_const auto OtherSecret = "another-param-token-secret"_tv;

// Plaintext encrypted in the original format: engine key ID, IV, AES-256-CTR
// ciphertext. Built outside the engine so it stands for a token stored before
// versioned tokens existed.
_const auto OriginalToken =
    "ToIyPoSGQk2sB2Mw+p3jhwARIjNEVWZ3iJmqu8zd7v8keCruq5OjbKIX+7fJDLD+nYfQ5iUEk"
    "Fr7hk6VipzIlh/027Ib+T1gHdheKRHqMeNE6BGgrF15lk4n"_tv;

// Plaintext encrypted in the versioned format with a key derived from Secret
// (AES-256-GCM, nonce a1b2c3d4e5f60718293a4b5c), also built outside the engine
_const auto VersionedToken =
    "UlJQVAKjsMihTjKM73eDBwNmPE2kobLD1OX2BxgpOktcjqgU80pMCmpMygLYyvKaSwGaP5Scy"
    "G5Cm1A3gw3wiOKzfZ6rwTIEvHUm91hE8tqgZkt3ldL8dKRfl9IUJJjJhw3zlLvORJ/sTsc="_tv;

// HKDF-SHA256 of Secret under each label
_const auto DerivedKey =
    "ea86cce405ea1cd5c441f1a610cdd86e83d0fe89f7f4b5616e2fb964a3313705"_tv;
_const auto DerivedKeyId = "a3b0c8a14e328cef77830703663c4da4"_tv;

// Offsets of the parts of a versioned token
_const size_t KeyIdOffset = crypto::ParamTokenHeader.size();
_const size_t NonceOffset = KeyIdOffset + crypto::ParamTokenKeyIdLength;
_const size_t CiphertextOffset = NonceOffset + crypto::ParamTokenNonceLength;

// Sets the deployment secret for the life of the scope, then restores it
class SecretEnvScope {
public:
    explicit SecretEnvScope(TextView value) noexcept
        : m_saved(plat::env(crypto::ParamTokenSecretEnv)) {
        plat::setEnv(crypto::ParamTokenSecretEnv, value);
    }
    ~SecretEnvScope() { plat::setEnv(crypto::ParamTokenSecretEnv, m_saved); }

private:
    Text m_saved;
};

auto toText(const Buffer &data) { return Text{data.toTextView()}; }

// A copy of the token with one bit flipped at the given offset
Buffer flipped(const Buffer &token, size_t offset) {
    Buffer copy(token);
    copy[offset] ^= 0x01;
    return copy;
}

}  // namespace

TEST_CASE("crypto::paramToken") {
    using namespace crypto;

    SECTION("original format without a secret") {
        auto token = *paramTokenEncrypt(Plaintext, {});

        // Same layout as the engine tokens: engine key ID, then the IV
        REQUIRE(token.slice(engineKeyId().size()) == engineKeyId());
        REQUIRE_FALSE(isVersionedParamToken(token));
        REQUIRE(toText(*engineDecrypt(token)) == Plaintext);
        REQUIRE(toText(*paramTokenDecrypt(token, {})) == Plaintext);
    }

    SECTION("stored original-format token decodes") {
        auto token = *base64Decode(OriginalToken);
        REQUIRE(toText(*paramTokenDecrypt(token, {})) == Plaintext);
        REQUIRE(toText(*paramTokenDecrypt(token, Secret)) == Plaintext);
    }

    SECTION("original-format token decodes with a secret set") {
        auto token = *paramTokenEncrypt(Plaintext, {});
        REQUIRE(toText(*paramTokenDecrypt(token, Secret)) == Plaintext);
    }

    SECTION("versioned format with a secret") {
        auto token = *paramTokenEncrypt(Plaintext, Secret);

        REQUIRE(isVersionedParamToken(token));
        REQUIRE(token.slice(ParamTokenHeader.size()) ==
                InputData{ParamTokenHeader});
        REQUIRE(token.sliceAt(KeyIdOffset, ParamTokenKeyIdLength) ==
                hexDecode(DerivedKeyId));
        REQUIRE(token.size() ==
                CiphertextOffset + Plaintext.size() + ParamTokenTagLength);
        REQUIRE(toText(*paramTokenDecrypt(token, Secret)) == Plaintext);

        // Every token gets its own nonce
        auto second = *paramTokenEncrypt(Plaintext, Secret);
        REQUIRE(second.sliceAt(NonceOffset, ParamTokenNonceLength) !=
                token.sliceAt(NonceOffset, ParamTokenNonceLength));
        REQUIRE(toText(*paramTokenDecrypt(second, Secret)) == Plaintext);
    }

    SECTION("stored versioned token decodes") {
        auto token = *base64Decode(VersionedToken);
        REQUIRE(toText(*paramTokenDecrypt(token, Secret)) == Plaintext);
    }

    SECTION("empty parameters") {
        auto token = *paramTokenEncrypt({}, Secret);
        REQUIRE(token.size() == CiphertextOffset + ParamTokenTagLength);
        REQUIRE(paramTokenDecrypt(token, Secret)->empty());
    }

    SECTION("versioned token without the secret fails") {
        auto token = *paramTokenEncrypt(Plaintext, Secret);
        auto res = paramTokenDecrypt(token, {});

        REQUIRE_ERROR(res, Ec::InvalidCipher, "which is not set");
        REQUIRE(res.ccode().message().contains(ParamTokenSecretEnv));
        REQUIRE_FALSE(_ts(res.ccode()).contains(Secret));

        // The original-format path does not read it either
        REQUIRE(engineDecrypt(token).hasCcode());
    }

    SECTION("versioned token with a different secret fails") {
        auto token = *paramTokenEncrypt(Plaintext, Secret);
        auto res = paramTokenDecrypt(token, OtherSecret);

        REQUIRE_ERROR(res, Ec::InvalidCipher, "a different",
                      ParamTokenSecretEnv);
        REQUIRE_FALSE(_ts(res.ccode()).contains(Secret));
        REQUIRE_FALSE(_ts(res.ccode()).contains(OtherSecret));
    }

    SECTION("wrong key behind a matching key ID fails") {
        // Give the token the key ID of the other secret, so only the
        // authentication tag can tell the key is wrong
        auto token = *paramTokenEncrypt(Plaintext, Secret);
        auto otherKey = *paramTokenKey(OtherSecret);
        token.copyAt(0, InputData{otherKey.prefix});

        REQUIRE_ERROR(paramTokenDecrypt(token, OtherSecret), Ec::InvalidCipher,
                      "failed authentication");
    }

    SECTION("altered versioned token fails") {
        auto token = *paramTokenEncrypt(Plaintext, Secret);
        const auto last = token.size() - 1;

        // Magic: no longer versioned, so the original-format path rejects it
        REQUIRE(paramTokenDecrypt(flipped(token, 0), Secret).hasCcode());

        // Version
        REQUIRE_ERROR(
            paramTokenDecrypt(flipped(token, KeyIdOffset - 1), Secret),
            Ec::NotSupported, "version 3 is not supported");

        // Key ID
        REQUIRE_ERROR(paramTokenDecrypt(flipped(token, KeyIdOffset), Secret),
                      Ec::InvalidCipher, "a different", ParamTokenSecretEnv);

        // Nonce, ciphertext and tag
        for (auto offset :
             {NonceOffset, NonceOffset + ParamTokenNonceLength - 1,
              CiphertextOffset, last - ParamTokenTagLength,
              last - ParamTokenTagLength + 1, last}) {
            auto res = paramTokenDecrypt(flipped(token, offset), Secret);
            REQUIRE_ERROR(res, Ec::InvalidCipher, "failed authentication");
            REQUIRE_FALSE(_ts(res.ccode()).contains(Secret));
        }

        // The stored token, altered in its ciphertext
        auto stored = *base64Decode(VersionedToken);
        REQUIRE_ERROR(
            paramTokenDecrypt(flipped(stored, CiphertextOffset + 5), Secret),
            Ec::InvalidCipher, "failed authentication");
    }

    SECTION("truncated versioned token fails") {
        auto token = *paramTokenEncrypt(Plaintext, Secret);

        for (auto length :
             {ParamTokenMagic.size(), ParamTokenHeader.size(), NonceOffset,
              CiphertextOffset, CiphertextOffset + ParamTokenTagLength - 1}) {
            Buffer truncated(token.slice(length));
            REQUIRE_ERROR(paramTokenDecrypt(truncated, Secret),
                          Ec::InvalidParam, "truncated");
        }

        // Long enough to parse, but cut off: the tag no longer matches
        for (auto length :
             {CiphertextOffset + ParamTokenTagLength, token.size() - 1}) {
            Buffer truncated(token.slice(length));
            REQUIRE_ERROR(paramTokenDecrypt(truncated, Secret),
                          Ec::InvalidCipher, "failed authentication");
        }
    }

    SECTION("formats do not overlap") {
        // A token in the original format starts with the engine key ID, which
        // never starts with the versioned magic
        REQUIRE(engineKeyId().slice(ParamTokenMagic.size()) !=
                InputData{ParamTokenMagic});
        REQUIRE_FALSE(isVersionedParamToken(engineKeyId()));
        REQUIRE_FALSE(isVersionedParamToken(*base64Decode(OriginalToken)));
        REQUIRE(isVersionedParamToken(*base64Decode(VersionedToken)));
    }

    SECTION("key derivation") {
        auto key = *paramTokenKey(Secret);

        // HKDF-SHA256 of the secret, not the secret itself
        REQUIRE(key.versioned);
        REQUIRE(hexEncode(key.key.keyData()) == DerivedKey);
        REQUIRE(key.key.keyData() != InputData{Secret});
        REQUIRE(key.key.cipher() == Cipher("aes-256-gcm"));
        REQUIRE(key.key.keyLength() == 32u);

        // A secret that is already the length of a key is still derived
        _const auto KeyLengthSecret = "0123456789abcdef0123456789abcdef"_tv;
        REQUIRE(KeyLengthSecret.size() == key.key.keyLength());
        REQUIRE(paramTokenKey(KeyLengthSecret)->key.keyData() !=
                InputData{KeyLengthSecret});

        // The key and the key ID come from separate labels
        auto keyId = *impl::deriveKeyDataFromKey(
            EVP_PKEY_HKDEF_MODE_EXTRACT_AND_EXPAND, Secret, {},
            ParamTokenKeyIdLabel, ParamTokenKeyIdLength);
        REQUIRE(hexEncode(keyId) == DerivedKeyId);
        REQUIRE(key.key.keyData().slice(ParamTokenKeyIdLength) != keyId);

        // Each label changes the output
        auto otherLabel = *impl::deriveKeyDataFromKey(
            EVP_PKEY_HKDEF_MODE_EXTRACT_AND_EXPAND, Secret, {},
            "rocketride parameter token key v3"_tv, key.key.keyLength());
        REQUIRE(key.key.keyData() != otherLabel);

        // A different secret gives a different key and key ID
        auto otherKey = *paramTokenKey(OtherSecret);
        REQUIRE(otherKey.key.keyData() != key.key.keyData());
        REQUIRE(InputData{otherKey.prefix} != InputData{key.prefix});

        // Without a secret it is the engine key
        auto engine = *paramTokenKey({});
        REQUIRE_FALSE(engine.versioned);
        REQUIRE(engine.key == engineKey());
        REQUIRE(InputData{engine.prefix} == engineKeyId());
    }

    SECTION("reads the secret from the environment") {
        Buffer token;
        {
            SecretEnvScope scope(Secret);
            REQUIRE(paramTokenSecret() == Secret);

            token = *paramTokenEncrypt(Plaintext);
            REQUIRE(isVersionedParamToken(token));
            REQUIRE(toText(*paramTokenDecrypt(token)) == Plaintext);
        }
        {
            SecretEnvScope scope({});
            REQUIRE_FALSE(paramTokenSecret());

            // Without it, encoding is the original format, as before
            auto original = *paramTokenEncrypt(Plaintext);
            REQUIRE_FALSE(isVersionedParamToken(original));
            REQUIRE(toText(*engineDecrypt(original)) == Plaintext);
            REQUIRE_ERROR(paramTokenDecrypt(token), Ec::InvalidCipher,
                          ParamTokenSecretEnv);
        }
    }
}
