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

namespace engine::keystore {

/**
 * @brief Definition of `KeyStoreFile`.
 *
 * The `KeyStoreFile` is implementation of the general `KeyStore` key store
 * interface, and keeps all its data in a JSON file. The main reason for this
 * implementation is unit-test functionality, and engine test tasks.
 */
class KeyStoreFile final : public KeyStore {
public:
    /**
     * @brief The trace flag for KeyStore component
     */
    _const auto LogLevel = Lvl::KeyStore;

public:
    using Parent = KeyStore;
    using Parent::deleteAll;
    using Parent::deleteKey;
    using Parent::getValue;
    using Parent::setValue;

    virtual ~KeyStoreFile() noexcept override;

    Error open(const Url &url) noexcept override;
    ErrorOr<Text> getValue(TextView partition, TextView key) noexcept override;
    Error setValue(TextView partition, TextView key,
                   TextView value) noexcept override;
    Error deleteKey(TextView partition, TextView key) noexcept override;
    Error deleteAll(TextView partition) noexcept override;
    ErrorOr<Values> getAll(TextView partition) noexcept override;
    Error copyAll(TextView srcPartition,
                  TextView destPartition) noexcept override;
    Error moveAll(TextView srcPartition, TextView destPartition,
                  bool deleteDest, bool skipEmptySource) noexcept override;

private:
    Error dump() noexcept;
    Error load(const Url &url) noexcept;

private:
    mutable async::SharedLock m_lock;
    bool m_inited = false;
    json::Value m_db;
    Url m_url;
};

}  // namespace engine::keystore
