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

class Cipher {
public:
    _const auto LogLevel = Lvl::Crypto;
    _const size_t AesBlockSize = 16;

    Cipher(TextView name) noexcept(false) : m_name(name) {
        ASSERTD(m_name);
        m_hCipher = EVP_get_cipherbyname(m_name);
        if (!m_hCipher)
            APERRT_THROW(Ec::InvalidCipher, "Invalid cipher algorithm", m_name);
    }

    Cipher(const Cipher&) = default;
    Cipher(Cipher&&) = default;

    iTextView name() const noexcept { return m_name; }

    size_t keyLength() const noexcept {
        return EVP_CIPHER_key_length(m_hCipher);
    }

    size_t ivLength() const noexcept { return EVP_CIPHER_iv_length(m_hCipher); }

    ErrorOr<Buffer> createIv() const noexcept {
        const auto length = ivLength();
        if (!length)
            return APERRT(Ec::InvalidState, "Cipher has no IV", m_name);
        return randomBytes(length);
    }

    size_t blockSize() const noexcept {
        // All AES-based ciphers use a block size of 16, but OpenSSL reports a
        // block size of 1 for the AES ciphers in stream mode, e.g. AES-CTR
        if (m_name.startsWith("aes")) {
            return AesBlockSize;
        }
        return minBlockSize();
    }

    size_t minBlockSize() const noexcept {
        return EVP_CIPHER_block_size(m_hCipher);
    }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << m_name;
    }

    // For bridging into OpenSSL API's
    operator const EVP_CIPHER*() const noexcept { return m_hCipher; }

    // @@TODO Replace with defaulted operator = when we update Clang
    bool equals(const Cipher& compare) const noexcept {
        return name() == compare.name();
    }

    bool operator==(const Cipher& compare) const noexcept {
        return equals(compare);
    }
    bool operator!=(const Cipher& compare) const noexcept {
        return !equals(compare);
    }

protected:
    const iText m_name;
    const EVP_CIPHER* m_hCipher = nullptr;
};

// Non-throwing Cipher init
inline ErrorOr<Cipher> getCipher(const char* name) noexcept {
    return _call([&] { return Cipher(name); });
}

}  // namespace ap::crypto