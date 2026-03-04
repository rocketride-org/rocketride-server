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

template <size_t DigestLen>
template <typename Buffer>
inline void Hash<DigestLen>::__toString(Buffer &buff) const noexcept {
    for (auto &chr : data)
        string::formatBuffer(buff, "{,X`,2}", _cast<uint8_t>(chr));
}

template <size_t DigestLen>
template <typename Buffer>
inline Error Hash<DigestLen>::__fromString(Hash &hash,
                                           const Buffer &buff) noexcept {
    if (buff.empty()) return {};

    auto str = buff.toString();
    if (str.size() != DigestLen * 2)
        return APERR(Ec::InvalidParam, "Hex-encoded hash has unexpected length",
                     str, str.size(), DigestLen * 2);

    for (size_t i = 0; i < DigestLen; ++i) {
        auto byte = _fsc<unsigned char>(str.substr(i * 2, 2), Format::HEX);
        if (!byte) return byte.ccode();
        hash.data[i] = byte.value();
    }
    return {};
}

// Specializations for specific hash types
template <>
class Api<Sha1Hash::DigestLen> {
public:
    _const auto DigestLen = Sha1Hash::DigestLen;
    using Type = Hash<DigestLen>;
    using Context = SHA_CTX;

    Api<Sha1Hash::DigestLen>() noexcept { SHA1_Init(&m_ctx); }

    void update(InputData data) noexcept {
        SHA1_Update(&m_ctx, data, data.size());
    }

    auto finalize() noexcept {
        Sha1Hash hash;
        SHA1_Final(hash, &m_ctx);
        return hash;
    }

    static auto make(InputData data) noexcept {
        Sha1Hash hash;
        SHA1(data, data.size(), hash);
        return hash;
    }

    template <typename In, typename = memory::adapter::concepts::IfInput<In>>
    static auto make(const In &in) noexcept(false) {
        static_assert(memory::adapter::concepts::IsInputV<In>);
        std::array<uint8_t, 64_kb> data;
        Api<Sha1Hash::DigestLen> ctx;
        while (auto len = _cast<size_t>(in.read(data, 0)))
            ctx.update(memory::DataView{&data.front(), len});
        return ctx.finalize();
    }

protected:
    Context m_ctx;
};

template <>
class Api<Sha256Hash::DigestLen> {
public:
    _const auto DigestLen = Sha256Hash::DigestLen;
    using Type = Hash<DigestLen>;
    using Context = SHA256_CTX;

    Api<Sha256Hash::DigestLen>() noexcept { SHA256_Init(&m_ctx); }

    void update(InputData data) noexcept {
        SHA256_Update(&m_ctx, data, data.size());
    }

    auto finalize() noexcept {
        Sha256Hash hash;
        SHA256_Final(hash, &m_ctx);
        return hash;
    }

    static auto make(InputData data) noexcept {
        Sha256Hash hash;
        SHA256(data, data.size(), hash);
        return hash;
    }

    template <typename In, typename = memory::adapter::concepts::IfInput<In>>
    static auto make(const In &in) noexcept(false) {
        static_assert(memory::adapter::concepts::IsInputV<In>);
        std::array<uint8_t, 64_kb> data;
        Api<Sha256Hash::DigestLen> ctx;
        while (auto len = _cast<size_t>(in.read(data, 0)))
            ctx.update(memory::DataView{&data.front(), len});
        return ctx.finalize();
    }

protected:
    Context m_ctx;
};

template <>
class Api<Sha512Hash::DigestLen> {
public:
    _const auto DigestLen = Sha512Hash::DigestLen;
    using Type = Hash<DigestLen>;
    using Context = SHA512_CTX;

    Api<Sha512Hash::DigestLen>() noexcept { SHA512_Init(&m_ctx); }

    void update(InputData data) noexcept {
        SHA512_Update(&m_ctx, data, data.size());
    }

    auto finalize() noexcept {
        Sha512Hash hash;
        SHA512_Final(hash, &m_ctx);
        return hash;
    }

    static auto make(InputData data) noexcept {
        Sha512Hash hash;
        SHA512(data, data.size(), hash);
        return hash;
    }

    template <typename In, typename = memory::adapter::concepts::IfInput<In>>
    static auto make(const In &in) noexcept(false) {
        static_assert(memory::adapter::concepts::IsInputV<In>);
        std::array<uint8_t, 64_kb> data;
        Api<Sha512Hash::DigestLen> ctx;
        while (auto len = _cast<size_t>(in.read(data, 0)))
            ctx.update(memory::DataView{&data.front(), len});
        return ctx.finalize();
    }

protected:
    Context m_ctx;
};

// SHA3-224
template <>
class Api<Sha224Hash::DigestLen> {
public:
    _const auto DigestLen = Sha224Hash::DigestLen;
    using Type = Hash<DigestLen>;
    using Context = EVP_MD_CTX *;

    Api<Sha224Hash::DigestLen>() noexcept {
        m_ctx = EVP_MD_CTX_create();
        EVP_DigestInit_ex(m_ctx, EVP_sha3_224(), nullptr);
    }

    ~Api<Sha224Hash::DigestLen>() noexcept { EVP_MD_CTX_destroy(m_ctx); }

    void update(InputData data) noexcept {
        EVP_DigestUpdate(m_ctx, data, data.size());
    }

    auto finalize() noexcept {
        Sha224Hash hash;
        unsigned int length = DigestLen;
        EVP_DigestFinal_ex(m_ctx, hash, &length);
        ASSERT(length == DigestLen);
        return hash;
    }

    static auto make(InputData data) noexcept {
        Api<Sha224Hash::DigestLen> ctx;
        ctx.update(data);
        return ctx.finalize();
    }

    template <typename In, typename = memory::adapter::concepts::IfInput<In>>
    static auto make(const In &in) noexcept(false) {
        static_assert(memory::adapter::concepts::IsInputV<In>);
        std::array<uint8_t, 64_kb> data;
        Api<Sha224Hash::DigestLen> ctx;
        while (auto len = _cast<size_t>(in.read(data, 0)))
            ctx.update(memory::DataView{&data.front(), len});
        return ctx.finalize();
    }

protected:
    Context m_ctx = {};
};

// SHA3-384
template <>
class Api<Sha384Hash::DigestLen> {
public:
    _const auto DigestLen = Sha384Hash::DigestLen;
    using Type = Hash<DigestLen>;
    using Context = EVP_MD_CTX *;

    Api<Sha384Hash::DigestLen>() noexcept {
        m_ctx = EVP_MD_CTX_create();
        EVP_DigestInit_ex(m_ctx, EVP_sha3_384(), nullptr);
    }

    ~Api<Sha384Hash::DigestLen>() noexcept { EVP_MD_CTX_destroy(m_ctx); }

    void update(InputData data) noexcept {
        EVP_DigestUpdate(m_ctx, data, data.size());
    }

    auto finalize() noexcept {
        Sha384Hash hash;
        unsigned int length = DigestLen;
        EVP_DigestFinal_ex(m_ctx, hash, &length);
        ASSERT(length == DigestLen);
        return hash;
    }

    static auto make(InputData data) noexcept {
        Api<Sha384Hash::DigestLen> ctx;
        ctx.update(data);
        return ctx.finalize();
    }

    template <typename In, typename = memory::adapter::concepts::IfInput<In>>
    static auto make(const In &in) noexcept(false) {
        static_assert(memory::adapter::concepts::IsInputV<In>);
        std::array<uint8_t, 64_kb> data;
        Api<Sha384Hash::DigestLen> ctx;
        while (auto len = _cast<size_t>(in.read(data, 0)))
            ctx.update(memory::DataView{&data.front(), len});
        return ctx.finalize();
    }

protected:
    Context m_ctx = {};
};

// Concrete instantiations
using Sha1 = Api<Sha1Hash::DigestLen>;
using Sha256 = Api<Sha256Hash::DigestLen>;
using Sha512 = Api<Sha512Hash::DigestLen>;
using Sha224 = Api<Sha224Hash::DigestLen>;
using Sha384 = Api<Sha384Hash::DigestLen>;

}  // namespace ap::crypto
