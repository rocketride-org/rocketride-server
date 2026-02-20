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

namespace ap::crypto {

// Forward-declare key class
class Key;

void init() noexcept;
void deinit() noexcept;
Text lastError() noexcept;

// Error-checking macro for OpenSSL API's
#define OPENSSL_CHECK(res) \
    if (res <= 0) return APERRL(Crypto, Ec::Cipher, lastError());

// Use the SHA3-224 hash of the key as the key's immutable ID
using ImmutableKeyId = Sha224Hash;
ImmutableKeyId immutableKeyId(InputData key) noexcept;

// Encrypt or decrypt (allocating)
ErrorOr<Buffer> decrypt(InputData ciphertext, const Key& key,
                        InputData iv) noexcept;
ErrorOr<Buffer> encrypt(InputData plaintext, const Key& key,
                        InputData iv) noexcept;

// Encrypt or decrypt (pre-allocated)
// These functions return the range within "out" that was ciphertext/plaintext
ErrorOr<OutputData> decrypt(InputData in, OutputData out, const Key& key,
                            InputData iv) noexcept;
ErrorOr<OutputData> encrypt(InputData in, OutputData out, const Key& key,
                            InputData iv) noexcept;

// Embed IV/key ID in buffer and encrypt data after
ErrorOr<Buffer> embedAndEncrypt(InputData plaintext, const Key& key,
                                InputData embeddedKeyId) noexcept;

// Extract embedded IV/key ID and decrypt following data
ErrorOr<Buffer> extractAndDecrypt(InputData ciphertext, const Key& key,
                                  InputData expectedEmbeddedKeyId) noexcept;

// The default path to the CA file on Unix systems
file::Path commonCertPath() noexcept;

// Get the cipher, key, and embedded key ID used by the engine to encrypt
// customer secrets as tokens
const Cipher& engineCipher() noexcept;
const Key& engineKey() noexcept;
InputData engineKeyId() noexcept;

// Decrypt data encrypted with the engine's key and prefixed with embedded key
// ID and IV
inline ErrorOr<Buffer> engineDecrypt(InputData ciphertext) noexcept {
    return extractAndDecrypt(ciphertext, engineKey(), engineKeyId());
}

// Encrypt data with the engine's key and embed the key ID and IV
inline ErrorOr<Buffer> engineEncrypt(InputData plaintext) noexcept {
    return embedAndEncrypt(plaintext, engineKey(), engineKeyId());
}

}  // namespace ap::crypto
