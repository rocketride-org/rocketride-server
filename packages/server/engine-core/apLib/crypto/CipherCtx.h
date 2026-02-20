#pragma once
/*====================================================================
 *Copyright (c) 1998-2016 The OpenSSL Project.  All rights reserved.
 *
 *Redistribution and use in source and binary forms, with or without
 *modification, are permitted provided that the following conditions
 *are met:
 *
 *1. Redistributions of source code must retain the above copyright
 *   notice, this list of conditions and the following disclaimer.
 *
 *2. Redistributions in binary form must reproduce the above copyright
 *   notice, this list of conditions and the following disclaimer in
 *   the documentation and/or other materials provided with the
 *   distribution.
 *
 *3. All advertising materials mentioning features or use of this
 *   software must display the following acknowledgment:
 *   "This product includes software developed by the OpenSSL Project
 *   for use in the OpenSSL Toolkit. (http://www.openssl.org/)"
 *
 *4. The names "OpenSSL Toolkit" and "OpenSSL Project" must not be used to
 *   endorse or promote products derived from this software without
 *   prior written permission. For written permission, please contact
 *   openssl-core@openssl.org.
 *
 *5. Products derived from this software may not be called "OpenSSL"
 *   nor may "OpenSSL" appear in their names without prior written
 *   permission of the OpenSSL Project.
 *
 *6. Redistributions of any form whatsoever must retain the following
 *   acknowledgment:
 *   "This product includes software developed by the OpenSSL Project
 *   for use in the OpenSSL Toolkit (http://www.openssl.org/)"
 *
 *THIS SOFTWARE IS PROVIDED BY THE OpenSSL PROJECT ``AS IS'' AND ANY
 *EXPRESSED OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 *IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 *PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE OpenSSL PROJECT OR
 *ITS CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 *SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 *LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 *HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
 *STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED
 *OF THE POSSIBILITY OF SUCH DAMAGE.
 *====================================================================
 *
 *This product includes cryptographic software written by Eric Young
 *(eay@cryptsoft.com).  This product includes software written by Tim
 *Hudson (tjh@cryptsoft.com).
 *
 */

namespace ap::crypto {

// This is a wrapper around the OpenSSL EVP cipher API
class CipherCtx {
public:
    _const auto LogLevel = Lvl::Crypto;

    // Do not allow moves or copies
    CipherCtx(const CipherCtx &) = delete;
    CipherCtx(CipherCtx &&) = delete;
    CipherCtx &operator=(const CipherCtx &) = delete;
    CipherCtx &operator=(CipherCtx &&) = delete;

    virtual ~CipherCtx() noexcept {
        // Free the cipher context
        EVP_CIPHER_CTX_free(m_ctx);
    }

    auto &cipher() const noexcept { return m_cipher; }

    // Reset the cipher context
    virtual Error reset() noexcept = 0;

    // Encrypt another block; updates the new cipher text to the output
    virtual Error update(size_t inlen, const uint8_t *in, size_t *outlen,
                         uint8_t *out) noexcept = 0;
    ErrorOr<OutputData> update(InputData in, OutputData out) noexcept;
    ErrorOr<Buffer> update(InputData in) noexcept;

    // Finalize the cipher stream
    virtual Error finalize(size_t *outlen, uint8_t *out) noexcept = 0;
    ErrorOr<OutputData> finalize(OutputData out) noexcept;
    Error finalize() noexcept;

    // Resets, updates, then finalizes
    Error resetUpdateFinal(size_t ulen, const uint8_t *u, size_t *rlen,
                           uint8_t *r) noexcept;

    // Updates the original IV with the offset
    Error setIv(uint64_t offset) noexcept;

protected:
    // Constructs the cipher, owns the ctx
    CipherCtx(const Key &key, InputData iv, bool encrypting) noexcept(false);

protected:
    const Cipher m_cipher;

    // The IV the object was constructed with
    memory::Data<uint8_t> m_initialIv;

    // Raw cipher instance ptr
    EVP_CIPHER_CTX *m_ctx = nullptr;
};

}  // namespace ap::crypto
