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

#include <core.h>

namespace ap::crypto {

namespace {
// Derive key material from the deployment secret with HKDF-SHA256 (extract
// and expand, no salt) under the given label
ErrorOr<Buffer> deriveParamTokenData(TextView secret, TextView label,
                                     size_t length) noexcept {
    return impl::deriveKeyDataFromKey(EVP_PKEY_HKDEF_MODE_EXTRACT_AND_EXPAND,
                                      secret, {}, label, length);
}

// The cipher of versioned tokens
const Cipher &paramTokenCipher() noexcept {
    static const Cipher cipher("aes-256-gcm");
    return cipher;
}

// Smart pointer wrapper for EVP_CIPHER_CTX
using ParamTokenCtxPtr =
    std::unique_ptr<EVP_CIPHER_CTX, void (*)(EVP_CIPHER_CTX *)>;

ErrorOr<ParamTokenCtxPtr> newParamTokenCtx() noexcept {
    auto ctx = EVP_CIPHER_CTX_new();
    if (!ctx)
        return APERRL(Crypto, Ec::Cipher, "Unable to create cipher context",
                      lastError());

    return ParamTokenCtxPtr(
        ctx, [](EVP_CIPHER_CTX *owned) { EVP_CIPHER_CTX_free(owned); });
}

// Encrypt into a versioned token: the prefix, a fresh nonce, the ciphertext
// and the tag, with the prefix authenticated as additional data
ErrorOr<Buffer> encryptVersioned(const ParamTokenKey &key,
                                 InputData plaintext) noexcept {
    if (plaintext.size() > _cast<size_t>(MaxValue<int>))
        return APERRL(Crypto, Ec::InvalidParam,
                      "Parameters are too large for a token");

    auto nonce = randomBytes(ParamTokenNonceLength);
    if (!nonce) return nonce.ccode();

    auto newCtx = newParamTokenCtx();
    if (!newCtx) return newCtx.ccode();
    auto ctx = _mv(*newCtx);

    const auto prefixLength = key.prefix.size();
    const auto bodyOffset = prefixLength + ParamTokenNonceLength;
    Buffer token(bodyOffset + plaintext.size() + ParamTokenTagLength);
    token.copyAt(0, InputData{key.prefix});
    token.copyAt(prefixLength, InputData{*nonce});

    int length = 0;
    OPENSSL_CHECK(EVP_EncryptInit_ex(ctx.get(), paramTokenCipher(), nullptr,
                                     nullptr, nullptr));
    OPENSSL_CHECK(EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_IVLEN,
                                      _cast<int>(ParamTokenNonceLength),
                                      nullptr));
    OPENSSL_CHECK(EVP_EncryptInit_ex(ctx.get(), nullptr, nullptr,
                                     key.key.keyData().data(), nonce->data()));
    OPENSSL_CHECK(EVP_EncryptUpdate(ctx.get(), nullptr, &length,
                                    key.prefix.data(),
                                    _cast<int>(prefixLength)));

    size_t written = 0;
    if (plaintext) {
        OPENSSL_CHECK(EVP_EncryptUpdate(ctx.get(), token.data() + bodyOffset,
                                        &length, plaintext.data(),
                                        _cast<int>(plaintext.size())));
        written = _cast<size_t>(length);
    }

    OPENSSL_CHECK(EVP_EncryptFinal_ex(
        ctx.get(), token.data() + bodyOffset + written, &length));
    written += _cast<size_t>(length);
    if (written != plaintext.size())
        return APERRL(Crypto, Ec::Bug, "Unexpected ciphertext length", written,
                      plaintext.size());

    OPENSSL_CHECK(EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_GET_TAG,
                                      _cast<int>(ParamTokenTagLength),
                                      token.data() + bodyOffset + written));
    return token;
}

// Decrypt a versioned token whose length and prefix were already checked.
// Nothing is returned unless the tag matches.
ErrorOr<Buffer> decryptVersioned(const ParamTokenKey &key,
                                 InputData token) noexcept {
    const auto prefixLength = key.prefix.size();
    const auto bodyOffset = prefixLength + ParamTokenNonceLength;
    const auto ciphertextLength =
        token.size() - bodyOffset - ParamTokenTagLength;
    if (ciphertextLength > _cast<size_t>(MaxValue<int>))
        return APERRL(Crypto, Ec::InvalidParam, "Parameter token is too large");

    const auto prefix = token.slice(prefixLength);
    const auto nonce = token.sliceAt(prefixLength, ParamTokenNonceLength);
    const auto ciphertext = token.sliceAt(bodyOffset, ciphertextLength);
    Buffer tag(token.sliceAt(bodyOffset + ciphertextLength));

    auto newCtx = newParamTokenCtx();
    if (!newCtx) return newCtx.ccode();
    auto ctx = _mv(*newCtx);

    // One spare byte so the output pointer is valid for empty parameters
    Buffer plaintext(ciphertextLength + 1);

    int length = 0;
    OPENSSL_CHECK(EVP_DecryptInit_ex(ctx.get(), paramTokenCipher(), nullptr,
                                     nullptr, nullptr));
    OPENSSL_CHECK(EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_IVLEN,
                                      _cast<int>(ParamTokenNonceLength),
                                      nullptr));
    OPENSSL_CHECK(EVP_DecryptInit_ex(ctx.get(), nullptr, nullptr,
                                     key.key.keyData().data(), nonce.data()));
    OPENSSL_CHECK(EVP_DecryptUpdate(ctx.get(), nullptr, &length, prefix.data(),
                                    _cast<int>(prefix.size())));

    size_t written = 0;
    if (ciphertext) {
        OPENSSL_CHECK(EVP_DecryptUpdate(ctx.get(), plaintext.data(), &length,
                                        ciphertext.data(),
                                        _cast<int>(ciphertext.size())));
        written = _cast<size_t>(length);
    }

    OPENSSL_CHECK(EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_TAG,
                                      _cast<int>(tag.size()), tag.data()));

    if (EVP_DecryptFinal_ex(ctx.get(), plaintext.data() + written, &length) <=
        0) {
        // Drop the unauthenticated output
        OPENSSL_cleanse(plaintext.data(), plaintext.size());
        ERR_clear_error();
        return APERRL(Crypto, Ec::InvalidCipher,
                      "Parameter token failed authentication: it was altered "
                      "or damaged");
    }

    written += _cast<size_t>(length);
    plaintext.resize(written);
    return plaintext;
}
}  // namespace

Text paramTokenSecret() noexcept { return plat::env(ParamTokenSecretEnv); }

ErrorOr<ParamTokenKey> paramTokenKey(TextView secret) noexcept {
    // Without a secret, keep the engine key and the original format
    if (!secret) return ParamTokenKey{engineKey(), Buffer(engineKeyId())};

    auto keyData = deriveParamTokenData(secret, ParamTokenKeyLabel,
                                        paramTokenCipher().keyLength());
    if (!keyData) return keyData.ccode();

    auto keyId = deriveParamTokenData(secret, ParamTokenKeyIdLabel,
                                      ParamTokenKeyIdLength);
    if (!keyId) return keyId.ccode();

    // The versioned format writes the header, then the key ID
    Buffer prefix(ParamTokenHeader.size() + keyId->size());
    prefix.copyAt(0, InputData{ParamTokenHeader});
    prefix.copyAt(ParamTokenHeader.size(), InputData{*keyId});

    return ParamTokenKey{Key(paramTokenCipher(), _mv(*keyData)), _mv(prefix),
                         true};
}

bool isVersionedParamToken(InputData token) noexcept {
    return token.size() >= ParamTokenMagic.size() &&
           token.slice(ParamTokenMagic.size()) == InputData{ParamTokenMagic};
}

ErrorOr<Buffer> paramTokenEncrypt(InputData plaintext,
                                  TextView secret) noexcept {
    auto key = paramTokenKey(secret);
    if (!key) return key.ccode();

    if (!key->versioned)
        return embedAndEncrypt(plaintext, key->key, key->prefix);

    return encryptVersioned(*key, plaintext);
}

ErrorOr<Buffer> paramTokenDecrypt(InputData token, TextView secret) noexcept {
    // A token without the magic is in the original format
    if (!isVersionedParamToken(token)) {
        auto key = paramTokenKey({});
        if (!key) return key.ccode();

        return extractAndDecrypt(token, key->key, key->prefix);
    }

    if (token.size() < ParamTokenHeader.size())
        return APERRL(Crypto, Ec::InvalidParam, "Parameter token is truncated");

    const auto version = token.data()[ParamTokenMagic.size()];
    if (version != ParamTokenVersion)
        return APERRL(Crypto, Ec::NotSupported,
                      _ts("Parameter token version ", _cast<int>(version),
                          " is not supported"));

    if (!secret)
        return APERRL(
            Crypto, Ec::InvalidCipher,
            _ts("Parameter token was encrypted with ", ParamTokenSecretEnv,
                ", which is not set on this engine"));

    auto key = paramTokenKey(secret);
    if (!key) return key.ccode();

    if (token.size() <
        key->prefix.size() + ParamTokenNonceLength + ParamTokenTagLength)
        return APERRL(Crypto, Ec::InvalidParam, "Parameter token is truncated");

    // Check the key ID first, so a token from another secret gets an error
    // that says so
    if (token.slice(key->prefix.size()) != key->prefix)
        return APERRL(Crypto, Ec::InvalidCipher,
                      _ts("Parameter token was encrypted with a different ",
                          ParamTokenSecretEnv));

    return decryptVersioned(*key, token);
}

}  // namespace ap::crypto
