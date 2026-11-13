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

// Generate random key
inline ErrorOr<Key> generateKey(const Cipher &cipher) noexcept {
    auto keyData = randomBytes(cipher.keyLength());
    if (!keyData) return keyData.ccode();

    return Key(cipher, _mv(keyData));
}

// Hide the internal API's used for unit testing
namespace impl {
// Derive key data from password using PBKDF2; see
// https://datatracker.ietf.org/doc/html/rfc2898 Allows key length to be
// specified directly for unit testing
inline ErrorOr<Buffer> deriveKeyDataFromPassword(TextView password,
                                                 InputData salt,
                                                 size_t iterations,
                                                 size_t keyLength) noexcept {
    Buffer keyData(keyLength);
    OPENSSL_CHECK(PKCS5_PBKDF2_HMAC_SHA1(
        password.data(), _cast<int>(password.length()), salt.data(),
        _cast<int>(salt.size()), _cast<int>(iterations),
        _cast<int>(keyData.size()), keyData));
    return keyData;
}
}  // namespace impl

// 1000 is the recommended minimum; see
// https://datatracker.ietf.org/doc/html/rfc2898
_const size_t MinimumKeyDerivationIterations = 4096;

// Derive key from password using PBKDF2; see
// https://datatracker.ietf.org/doc/html/rfc2898
inline ErrorOr<Key> deriveKeyFromPassword(const Cipher &cipher,
                                          TextView password, InputData salt,
                                          size_t iterations) noexcept {
    auto keyData = impl::deriveKeyDataFromPassword(password, salt, iterations,
                                                   cipher.keyLength());
    if (!keyData) return keyData.ccode();

    return Key(cipher, _mv(keyData));
}

// Hide the internal API's used for unit testing
namespace impl {
// Smart pointer wrapper for EVP_PKEY_CTX
using EvpPKeyCtxPtr = std::unique_ptr<EVP_PKEY_CTX, void (*)(EVP_PKEY_CTX *)>;

// Initialize the EVP public key context and set the hash and HKDF mode
// Although we're using the public key API to invoke HKDF, there's nothing
// specific to public keys in this API, i.e. symmetric keys work just as well
inline ErrorOr<EvpPKeyCtxPtr> initPKeyCtx(int mode) noexcept {
    auto evpCtx = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, nullptr);
    if (!evpCtx)
        return APERRL(Crypto, Ec::Cipher, "Unable to create HKDF context",
                      lastError());

    auto ctx = EvpPKeyCtxPtr(evpCtx,
                             [](EVP_PKEY_CTX *ctx) { EVP_PKEY_CTX_free(ctx); });
    OPENSSL_CHECK(EVP_PKEY_derive_init(ctx.get()));
    OPENSSL_CHECK(EVP_PKEY_CTX_hkdf_mode(ctx.get(), mode));
    OPENSSL_CHECK(EVP_PKEY_CTX_set_hkdf_md(ctx.get(), EVP_sha256()));
    return ctx;
}

// Derive key from key using HKDF; see
// https://datatracker.ietf.org/doc/html/rfc5869 Allows key length to be
// specified directly for unit testing
inline ErrorOr<Buffer> deriveKeyDataFromKey(int mode, InputData key,
                                            InputData salt, InputData info,
                                            size_t derivedKeyLength) noexcept {
    auto ctx = initPKeyCtx(mode);
    if (!ctx) return ctx.ccode();

    OPENSSL_CHECK(EVP_PKEY_CTX_set1_hkdf_key(ctx.get(), key.data(),
                                             _cast<int>(key.size())));
    if (salt)
        OPENSSL_CHECK(EVP_PKEY_CTX_set1_hkdf_salt(ctx.get(), salt.data(),
                                                  _cast<int>(salt.size())));
    if (info)
        OPENSSL_CHECK(EVP_PKEY_CTX_add1_hkdf_info(ctx.get(), info.data(),
                                                  _cast<int>(info.size())));

    Buffer keyData(derivedKeyLength);
    size_t outLen = keyData.size();
    OPENSSL_CHECK(EVP_PKEY_derive(ctx.get(), keyData.data(), &outLen));
    if (outLen != keyData.size())
        return APERRL(Crypto, Ec::Cipher,
                      "Derived key is of an unexpected length", outLen,
                      lastError());

    return keyData;
}
}  // namespace impl

// Derive key from key using HKDF; see
// https://datatracker.ietf.org/doc/html/rfc5869
inline ErrorOr<Key> deriveKeyFromKey(const Key &key, InputData info,
                                     InputData salt = {}) noexcept {
    // Configure HKDF to expand only since the input is already sufficiently
    // random See https://en.wikipedia.org/wiki/HKDF
    auto keyData = impl::deriveKeyDataFromKey(EVP_PKEY_HKDEF_MODE_EXTRACT_ONLY,
                                              key.keyData(), salt, info,
                                              key.cipher().keyLength());
    if (!keyData) return keyData.ccode();

    return Key(key.cipher(), _mv(keyData));
}

}  // namespace ap::crypto