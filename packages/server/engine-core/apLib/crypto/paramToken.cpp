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

#include <apLib/ap.h>

namespace ap::crypto {

namespace {
// Derive key material from the deployment secret with HKDF-SHA256 (extract
// and expand, no salt) under the given label
ErrorOr<Buffer> deriveParamTokenData(TextView secret, TextView label,
                                     size_t length) noexcept {
    return impl::deriveKeyDataFromKey(EVP_PKEY_HKDEF_MODE_EXTRACT_AND_EXPAND,
                                      secret, {}, label, length);
}
}  // namespace

Text paramTokenSecret() noexcept { return plat::env(ParamTokenSecretEnv); }

ErrorOr<ParamTokenKey> paramTokenKey(TextView secret) noexcept {
    // Without a secret, keep the engine key and the original format
    if (!secret) return ParamTokenKey{engineKey(), Buffer(engineKeyId())};

    auto keyData = deriveParamTokenData(secret, ParamTokenKeyLabel,
                                        engineCipher().keyLength());
    if (!keyData) return keyData.ccode();

    auto keyId = deriveParamTokenData(secret, ParamTokenKeyIdLabel,
                                      ParamTokenKeyIdLength);
    if (!keyId) return keyId.ccode();

    // The versioned format writes the header, then the key ID
    Buffer prefix(ParamTokenHeader.size() + keyId->size());
    prefix.copyAt(0, InputData{ParamTokenHeader});
    prefix.copyAt(ParamTokenHeader.size(), InputData{*keyId});

    return ParamTokenKey{Key(engineCipher(), _mv(*keyData)), _mv(prefix)};
}

bool isVersionedParamToken(InputData token) noexcept {
    return token.size() >= ParamTokenHeader.size() &&
           token.slice(ParamTokenHeader.size()) == InputData{ParamTokenHeader};
}

ErrorOr<Buffer> paramTokenEncrypt(InputData plaintext,
                                  TextView secret) noexcept {
    auto key = paramTokenKey(secret);
    if (!key) return key.ccode();

    return embedAndEncrypt(plaintext, key->key, key->prefix);
}

ErrorOr<Buffer> paramTokenDecrypt(InputData token, TextView secret) noexcept {
    // A token without the header is in the original format
    if (!isVersionedParamToken(token)) {
        auto key = paramTokenKey({});
        if (!key) return key.ccode();

        return extractAndDecrypt(token, key->key, key->prefix);
    }

    if (!secret)
        return APERRL(
            Crypto, Ec::InvalidCipher,
            _ts("Parameter token was encrypted with ", ParamTokenSecretEnv,
                ", which is not set on this engine"));

    auto key = paramTokenKey(secret);
    if (!key) return key.ccode();

    // Check the key ID before decrypting, so a token from another secret
    // fails here instead of decrypting into unreadable bytes
    if (token.size() < key->prefix.size() + key->key.cipher().ivLength())
        return APERRL(Crypto, Ec::InvalidParam, "Parameter token is truncated");

    if (token.slice(key->prefix.size()) != key->prefix)
        return APERRL(Crypto, Ec::InvalidCipher,
                      _ts("Parameter token was encrypted with a different ",
                          ParamTokenSecretEnv));

    return extractAndDecrypt(token, key->key, key->prefix);
}

}  // namespace ap::crypto
