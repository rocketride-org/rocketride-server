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

// Contains cipher, key, and key identifiers
class Key {
public:
    _const auto LogLevel = Lvl::Crypto;

    Key(const Cipher &cipher, Buffer key, Text id = {}) noexcept
        : m_cipher(cipher),
          m_key(_mv(key), m_cipher.keyLength()),
          m_immutableId(_ts(immutableKeyId(m_key))),
          m_id(_mv(id)) {
        ASSERTD(m_key && m_immutableId);

        // Default the ID to the immutable ID
        if (!m_id) m_id = m_immutableId;
    }

    Key(const Cipher &cipher, TextView hexKey, Text id = {}) noexcept(false)
        : Key(cipher, hexDecode(hexKey), _mv(id)) {}

    Key(const Key &) = default;
    Key(Key &&) = default;

    auto &cipher() const { return m_cipher; }
    InputData keyData() const noexcept { return m_key; }
    auto keyLength() const noexcept { return m_key.size(); }
    TextView immutableId() const noexcept { return m_immutableId; }
    TextView id() const noexcept { return m_id; }
    // ID must not be updated after key is added to a keyring
    auto &id() noexcept { return m_id; }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << m_id;
    }

    static Key __fromJson(const json::Value &value) noexcept(false) {
        auto id = _fj<Text>(value["id"]);
        if (!id) APERRL_THROW(Crypto, Ec::InvalidParam, "Key is missing ID");

        // Hex-decode the key
        auto token = hexDecode(_fj<Text>(value["token"]));
        if (!token)
            APERRL_THROW(Crypto, Ec::InvalidParam, "Key is missing token");

        // Decrypt the key using the master key
        return Key(engineCipher(), *engineDecrypt(token), _mv(id));
    }

    Error __toJson(json::Value &value) const noexcept {
        value["id"] = m_id;

        // Encrypt key with the master key
        auto encrypted = engineEncrypt(m_key);
        if (!encrypted) return encrypted.ccode();

        // Hex-encode the encrypted key
        value["token"] = hexEncode(*encrypted);

        return {};
    }

    // @@TODO Replace with defaulted operator = when we update Clang
    bool equals(const Key &compare) const noexcept {
        if (m_cipher != compare.m_cipher) return false;
        // We only need to compare either the key or its immutable ID
        if (m_immutableId != compare.m_immutableId) return false;
        if (m_id != compare.m_id) return false;
        return true;
    }

    bool operator==(const Key &compare) const noexcept {
        return equals(compare);
    }
    bool operator!=(const Key &compare) const noexcept {
        return !equals(compare);
    }

protected:
    Cipher m_cipher;
    Buffer m_key;
    // Store immutable ID, i.e. hash, as the rendered hex form, since we don't
    // need the actual hash for anything
    Text m_immutableId;
    Text m_id;
};

}  // namespace ap::crypto