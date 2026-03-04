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

namespace engine::keystore {

/**
 * @brief Definition of `ServiceKeyStore`
 *
 * `ServiceKeyStore` add one additional level of abstraction, and main readon of
 * it is to allow usage of several instances of the same nodes, each of them
 * with its own `ConfigSubKey`. It is used as a wrapper around another key-store
 * (the real one, which does that job).
 */
class ServiceKeyStore final : public KeyStore {
public:
    /**
     * @brief The trace flag for KeyStore component
     */
    _const auto LogLevel = Lvl::KeyStore;

    ServiceKeyStore(TextView serviceKey, SharedPtr<KeyStore> keystore) noexcept;

    virtual Url getUrl() const noexcept override;

    virtual Error open(const Url &url) noexcept override;
    virtual ErrorOr<Text> getValue(TextView partition,
                                   TextView key) noexcept override;
    virtual Error setValue(TextView partition, TextView key,
                           TextView value) noexcept override;
    virtual Error deleteKey(TextView partition, TextView key) noexcept override;
    virtual Error deleteAll(TextView partition) noexcept override;
    virtual ErrorOr<Values> getAll(TextView partition) noexcept override;
    virtual Error copyAll(TextView srcPartition,
                          TextView destPartition) noexcept override;
    virtual Error moveAll(TextView srcPartition, TextView destPartition,
                          bool deleteDest,
                          bool skipEmptySource) noexcept override;

private:
    Text servicePartition(TextView partition) noexcept;

    /**
     * @brief Service key.
     *
     * It is used as a part of partition name in subsequent calls to the wrapped
     * key-store
     *
     */
    const Text m_serviceKey;

    /**
     * @brief Pointer to the real keystore
     *
     */
    SharedPtr<KeyStore> m_keystore;
};

}  // namespace engine::keystore
