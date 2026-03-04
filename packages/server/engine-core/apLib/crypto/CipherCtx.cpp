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

CipherCtx::CipherCtx(const Key &key, InputData iv,
                     bool encrypting) noexcept(false)
    : m_cipher(key.cipher()) {
    // Verify there is enough keying data for the algorithm
    const auto expectedLeyLength = m_cipher.keyLength();
    if (key.keyData().size() < expectedLeyLength)
        APERRT_THROW(Ec::InvalidParam, "Invalid key length", key.keyLength(),
                     "expecting", expectedLeyLength);

    // Verify there is enough IV data for the algorithm
    const auto expectedIvLength = m_cipher.ivLength();
    if (iv.size() != expectedIvLength)
        APERRT_THROW(Ec::InvalidParam, "Invalid IV length", iv.size(),
                     "expecting", expectedIvLength);

    // Get a new cipher context
    m_ctx = EVP_CIPHER_CTX_new();
    if (!m_ctx)
        APERRT_THROW(Ec::Cipher, "Failed to allocate cipher context",
                     lastError());

    // Init the cipher pointer
    EVP_CipherInit_ex(m_ctx, m_cipher, nullptr, nullptr, nullptr, encrypting);

    // Set the key length on the context
    EVP_CIPHER_CTX_set_key_length(m_ctx, _cast<int>(key.keyLength()));

    // Now, init the key and the iv
    const auto keyData = _reCast<const unsigned char *>(key.keyData().data());
    const auto ivData = _reCast<const unsigned char *>(iv.data());
    if (!EVP_CipherInit_ex(m_ctx, nullptr, nullptr, keyData, ivData,
                           encrypting))
        APERRT_THROW(Ec::Cipher, "Unable to initialize cipher", lastError());

    m_initialIv = iv;
}

ErrorOr<OutputData> CipherCtx::update(InputData in, OutputData out) noexcept {
    auto length = out.size();
    if (auto ccode = update(in.size(), in, &length, out)) return ccode;

    return out.slice(length);
}

ErrorOr<Buffer> CipherCtx::update(InputData in) noexcept {
    Buffer out(in.size());
    auto length = out.size();
    if (auto ccode = update(in.size(), in, &length, out)) return ccode;

    out.resize(length);
    return out;
}

ErrorOr<OutputData> CipherCtx::finalize(OutputData out) noexcept {
    auto length = out.size();
    if (auto ccode = finalize(&length, out)) return ccode;

    return out.slice(length);
}

Error CipherCtx::finalize() noexcept {
    size_t ignored = {};
    auto ccode = finalize(&ignored, nullptr);
    ASSERT_MSG(!ignored, "No finalize output expected");
    return ccode;
}

// Resets, updates, then finalizes
Error CipherCtx::resetUpdateFinal(size_t inlen, const uint8_t *in,
                                  size_t *outlen, uint8_t *out) noexcept {
    if (auto ccode = reset()) return ccode;

    auto updateLen = *outlen;
    if (auto ccode = update(inlen, in, &updateLen, out)) return ccode;

    auto finalLen = *outlen - updateLen;
    if (auto ccode = finalize(&finalLen, out + updateLen)) return ccode;

    *outlen = updateLen + finalLen;
    return {};
}

Error CipherCtx::setIv(uint64_t offset) noexcept {
    auto blockSize = m_cipher.blockSize();
    if (offset % blockSize)
        return APERRT(
            Ec::Cipher,
            "Offset should be a multiple of Cipher Block size:", blockSize);

    // Nothing changed - don't update the IV
    uint64_t blockOffset = offset / blockSize;
    if (!blockOffset) return {};

    // Add an offset to the initial IV
    unsigned char *cipherIv = EVP_CIPHER_CTX_iv_noconst(m_ctx);
    if (!cipherIv) {
        return APERRT(Ec::Cipher, "Unable to get the IV", lastError());
    }

    const auto bytes = _cast<int>(m_cipher.ivLength() - 1);
    for (int i = bytes; blockOffset != 0 && i >= 0; i--) {
        uint64_t newVal = m_initialIv[i] + blockOffset;
        cipherIv[i] = newVal & 0xff;
        blockOffset = newVal >> 8;
    }
    return {};
}

}  // namespace ap::crypto
