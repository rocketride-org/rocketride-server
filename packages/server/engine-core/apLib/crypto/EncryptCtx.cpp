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

Error EncryptCtx::reset() noexcept {
    if (!EVP_EncryptInit_ex(m_ctx, nullptr, nullptr, nullptr, nullptr))
        return APERRT(Ec::Cipher, "Unable to init encryption", lastError());
    return {};
}

Error EncryptCtx::update(size_t inlen, const uint8_t *in, size_t *outlen,
                         uint8_t *out) noexcept {
    auto _outlen = _nc<int>(*outlen);
    if (!EVP_EncryptUpdate(m_ctx, out, &_outlen, in, _nc<int>(inlen)))
        return APERRT(Ec::Cipher, "Unable to update encryption", lastError());
    *outlen = _cast<size_t>(_outlen);
    return {};
}

Error EncryptCtx::finalize(size_t *outlen, uint8_t *out) noexcept {
    auto _outlen = _nc<int>(*outlen);
    if (!EVP_EncryptFinal_ex(m_ctx, out, &_outlen))
        return APERRT(Ec::Cipher, "Unable to finalize encryption", lastError());
    *outlen = _cast<size_t>(_outlen);
    return {};
}

Error EncryptCtx::encrypt(size_t ulen, const uint8_t *u, size_t *rlen,
                          uint8_t *r) noexcept {
    return resetUpdateFinal(ulen, u, rlen, r);
}

ErrorOr<OutputData> EncryptCtx::encrypt(InputData in, OutputData out) noexcept {
    auto length = out.size();
    if (auto ccode = encrypt(in.size(), in, &length, out)) return ccode;

    return out.slice(length);
}

ErrorOr<Buffer> EncryptCtx::encrypt(InputData in, size_t outLength) {
    Buffer out(alignUp(outLength, m_cipher.blockSize()));
    auto res = encrypt(in, OutputData{out});
    if (!res) return res.ccode();

    out.resize(res->size());
    return out;
}

}  // namespace ap::crypto