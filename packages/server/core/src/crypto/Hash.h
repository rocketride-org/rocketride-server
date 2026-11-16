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

// A hash represents a low level byte array of hashed characters
template <size_t DigestLenT>
struct Hash {
    _const auto DigestLen = DigestLenT;
    _const auto StrLen = DigestLenT * 2;

    Array<uint8_t, DigestLenT> data;

    template <typename Buffer>
    void __toString(Buffer& buff) const noexcept;

    template <typename Buffer>
    static Error __fromString(Hash& hash, const Buffer& buff) noexcept;

    operator uint8_t*() noexcept { return _cast<uint8_t*>(&data.front()); }

    operator const uint8_t*() const noexcept {
        return _cast<const uint8_t*>(&data.front());
    }

    bool operator==(const Hash& other) const noexcept {
        return data == other.data;
    }

    bool operator!=(const Hash& other) const noexcept {
        return !operator==(other);
    }

    bool operator<(const Hash& other) const noexcept {
        return data < other.data;
    }

    explicit operator bool() const noexcept { return *this != Hash(); }

    template <typename Out>
    auto __toData(Out& out) const noexcept(false) {
        out.write(data);
    }

    template <typename In>
    static auto __fromData(Hash& h, const In& in) noexcept(false) {
        in.read(h.data);
    }

    operator memory::DataView<const uint8_t>() const noexcept { return data; }
};

// Base api template un-specialized form
template <size_t DigestLenT>
struct Api;

// Concrete aliases
using Sha1Hash = Hash<SHA_DIGEST_LENGTH>;

// SHA-2
using Sha256Hash = Hash<SHA256_DIGEST_LENGTH>;
using Sha512Hash = Hash<SHA512_DIGEST_LENGTH>;

// SHA-3
using Sha224Hash = Hash<SHA224_DIGEST_LENGTH>;
using Sha384Hash = Hash<SHA384_DIGEST_LENGTH>;

}  // namespace ap::crypto

// Add a hash specialization for hash so it can work in unordered maps/sets
namespace std {
template <size_t DigestLenT>
struct hash<::ap::crypto::Hash<DigestLenT>> {
    using HashType = ::ap::crypto::Hash<DigestLenT>;

    size_t operator()(const HashType& h) const noexcept {
        size_t result = 0;
        std::hash<uint8_t> hasher;
        for (const auto& element : h.data)
            result = result * 31 + hasher(element);
        return result;
    }
};
}  // namespace std
