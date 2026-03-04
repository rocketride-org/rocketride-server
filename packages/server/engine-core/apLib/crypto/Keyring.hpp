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

class Keyring {
public:
    _const auto LogLevel = Lvl::Crypto;

    Error addKey(Key key) noexcept {
        // Check for dupes
        if (getKeyById(key.id()))
            return APERRT(Ec::InvalidParam, "Duplicate key ID in keyring",
                          key.id());
        if (getKeyByImmutableId(key.immutableId()))
            return APERRT(Ec::InvalidParam, "Duplicate key in keyring",
                          key.immutableId());

        m_keys.emplace_back(_mv(key));
        return {};
    }

    // The default key is the last, i.e. most preferred, key
    Opt<Key> defaultKey() const noexcept {
        if (empty()) return {};
        return m_keys.back();
    }

    TextView defaultKeyId() const noexcept {
        if (empty()) return {};
        return m_keys.back().id();
    }

    ErrorOr<Key> getKeyById(TextView id) const noexcept {
        if (empty()) return APERRT(Ec::NotFound, "Keyring is empty", id);

        for (auto& key : m_keys) {
            if (key.id() == id) return key;
        }
        return APERRT(Ec::NotFound, "Key ID not found", id);
    }

    ErrorOr<Key> getKeyByImmutableId(TextView immutableId) const noexcept {
        if (empty())
            return APERRT(Ec::NotFound, "Keyring is empty", immutableId);

        for (auto& key : m_keys) {
            if (key.immutableId() == immutableId) return key;
        }
        return APERRT(Ec::NotFound, "Key not found", immutableId);
    }

    bool empty() const noexcept { return m_keys.empty(); }

    // Iterate keys in reverse order
    auto begin() const noexcept { return m_keys.rbegin(); }
    auto end() const noexcept { return m_keys.rend(); }

    explicit operator bool() const noexcept { return !empty(); }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        _tsbd(buff, m_keys);
    }

    static Error __fromJson(Keyring& keyring,
                            const json::Value& value) noexcept {
        for (auto& keyJson : value) {
            auto key = _fjc<Key>(keyJson);
            if (!key) return key.ccode();
            if (auto ccode = keyring.addKey(_mv(*key))) return ccode;
        }
        return {};
    }

    Error __toJson(json::Value& value) const noexcept {
        // Make sure the value is an empty array if the key ring is empty
        value = json::ValueType::arrayValue;

        // Iterate the keys in their original order
        for (auto& key : m_keys) {
            auto jsonKey = _tjc(key);
            if (!jsonKey) return jsonKey.ccode();

            value.append(*jsonKey);
        }

        return {};
    }

    bool equals(const Keyring& compare) const noexcept {
        if (m_keys.size() != compare.m_keys.size()) return false;

        // Keyrings are implicitly ordered, so any key being different means a
        // different keyring
        for (size_t i = 0; i < m_keys.size(); ++i) {
            if (m_keys[i] != compare.m_keys[i]) return false;
        }

        return true;
    }

    bool operator==(const Keyring& compare) const noexcept {
        return equals(compare);
    }
    bool operator!=(const Keyring& compare) const noexcept {
        return !equals(compare);
    }

protected:
    std::vector<Key> m_keys;
};

}  // namespace ap::crypto
