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

// Decrypts a buffer (allocated)
inline ErrorOr<Buffer> decrypt(InputData ciphertext, const Key& key,
                               InputData iv) noexcept {
    if (!ciphertext) return Buffer();

    return _call([&] {
        DecryptCtx ctx(key, iv);
        return ctx.decrypt(
            ciphertext, alignUp(ciphertext.size(), ctx.cipher().blockSize()));
    });
}

// Decrypts a buffer (pre-allocated)
inline ErrorOr<OutputData> decrypt(InputData in, OutputData out, const Key& key,
                                   InputData iv) noexcept {
    if (!in) return OutputData();

    return _call([&] {
        DecryptCtx ctx(key, iv);
        return ctx.decrypt(in, out);
    });
}

// Encrypts a buffer (allocated)
inline ErrorOr<Buffer> encrypt(InputData plaintext, const Key& key,
                               InputData iv) noexcept {
    if (!plaintext) return Buffer();

    return _call([&] {
        EncryptCtx ctx(key, iv);
        return ctx.encrypt(plaintext, plaintext.size() + 1_kb);
    });
}

// Encrypts a buffer (pre-allocated)
inline ErrorOr<OutputData> encrypt(InputData in, OutputData out, const Key& key,
                                   InputData iv) noexcept {
    if (!in) return OutputData();

    return _call([&] {
        EncryptCtx ctx(key, iv);
        return ctx.encrypt(in, out);
    });
}

// Extract embedded key ID and IV and decrypt following data
inline ErrorOr<Buffer> extractAndDecrypt(
    InputData ciphertext, const Key& key,
    InputData expectedEmbeddedKeyId) noexcept {
    if (!ciphertext) return Buffer();

    const auto embeddedKeyId = ciphertext.slice(expectedEmbeddedKeyId.size());
    ciphertext = ciphertext.sliceAt(expectedEmbeddedKeyId.size());
    if (embeddedKeyId != expectedEmbeddedKeyId)
        return APERRL(
            Crypto, Ec::InvalidCipher,
            "Key ID does not match expected value:", hexEncode(embeddedKeyId),
            "!=", hexEncode(expectedEmbeddedKeyId));

    // Extract the embedded IV
    const auto ivLength = key.cipher().ivLength();
    if (!ivLength) return APERRL(Crypto, Ec::Bug, "Cipher doesn't use IV's");

    const auto embeddedIv = ciphertext.slice(ivLength);
    ciphertext = ciphertext.sliceAt(ivLength);

    return _call([&] {
        DecryptCtx ctx(key, embeddedIv);
        return ctx.decrypt(
            ciphertext, alignUp(ciphertext.size(), ctx.cipher().blockSize()));
    });
}

// Embed key ID and IV in buffer and encrypt data after
inline ErrorOr<Buffer> embedAndEncrypt(InputData plaintext, const Key& key,
                                       InputData embeddedKeyId) noexcept {
    if (!plaintext) return Buffer();

    // Calculate length of embedded data
    const auto keyIdLength = embeddedKeyId.size();
    const auto ivLength = key.cipher().ivLength();
    if (!ivLength) return APERRL(Crypto, Ec::Bug, "Cipher doesn't use IV's");

    const auto embeddedDataLength = keyIdLength + ivLength;
    Buffer result(embeddedDataLength + plaintext.size() + 1_kb);

    // Embed key ID
    result.copyAt(0, embeddedKeyId);

    // Embed new IV
    const auto embeddedIv = key.cipher().createIv();
    if (!embeddedIv) return embeddedIv.ccode();

    result.copyAt(keyIdLength, *embeddedIv);

    // Encrypt the data using the embedded key
    auto callback = [&] {
        EncryptCtx ctx(key, *embeddedIv);
        auto ciphertext =
            *ctx.encrypt(plaintext, result.sliceAt(embeddedDataLength));

        // Adjust the size of the buffer
        const auto ciphertextLength = ciphertext.size();
        ASSERTD(embeddedDataLength + ciphertextLength <= result.size());
        result.resize(embeddedDataLength + ciphertextLength);
        return result;
    };
    return _call(_mv(callback));
}

}  // namespace ap::crypto
