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

class KeyStore;
using KeyStorePtr = SharedPtr<KeyStore>;

/**
 * @brief Definition of `KeyStore` interface
 *
 */
class KeyStore {
public:
    using Values = std::map<Text, Text>;
    // default partition
    inline static const auto PARTITION_DEFAULT = "default"_tv;

    /**
     * Destructor
     */
    virtual ~KeyStore() {}

    /**
     * @brief Get the URL
     *
     * @return The `Url` object
     */
    virtual Url getUrl() const noexcept { return m_Url; }

    /**
     * @brief Open the key store
     *
     * @param url Url to open
     * @return Error if open failed
     */
    virtual Error open(const Url &url) noexcept = 0;

    /**
     * @brief Get value of the key for the corresponding partition
     *
     * @param partition Partition name
     * @param key Key name
     * @return Value of the corresponding key inside the corresponding
     * partition, or error
     */
    virtual ErrorOr<Text> getValue(TextView partition,
                                   TextView key) noexcept = 0;

    /**
     * @brief Get value of the key for the default partition
     *
     * @param key Key name
     * @return Value of the corresponding key inside the default partition, or
     * error
     */
    ErrorOr<Text> getValue(TextView key) noexcept;

    /**
     * @brief Set value for the key inside the corresponding partition
     *
     * @param partition Partition name
     * @param key Key name
     * @param value Value to set
     * @return Error if set failed
     */
    virtual Error setValue(TextView partition, TextView key,
                           TextView value) noexcept = 0;

    /**
     * @brief Set value for the key inside the default partition
     *
     * @param key Key name
     * @param value Value to set
     * @return Error if set failed
     */
    Error setValue(TextView key, TextView value) noexcept;

    /**
     * @brief Get value of the key for the default partition
     *
     * @param key Key name
     * @return Value of the corresponding key inside the default partition, or
     * error
     */
    ErrorOr<Text> getSecureValue(TextView key) noexcept;

    /**
     * @brief Set value for the key inside the default partition
     *
     * @param key Key name
     * @param value Value to set
     * @return Error if set failed
     */
    Error setSecureValue(TextView key, TextView value) noexcept;

    /**
     * @brief Delete the corresponding key from the corresponding partition
     *
     * @param partition Partition name
     * @param key Key name
     * @return Error if delete failed
     */
    virtual Error deleteKey(TextView partition, TextView key) noexcept = 0;

    /**
     * @brief Delete the corresponding key from the default partition
     *
     * @param key Key name
     * @return Error if delete failed
     */
    Error deleteKey(TextView key) noexcept;

    /**
     * @brief Delete everything from the corresponding partition
     *
     * @param partition Partition name
     * @return Error if deleteAll failed
     */
    virtual Error deleteAll(TextView partition) noexcept = 0;

    /**
     * @brief Delete everything from the default partition
     *
     * @return Error if deleteAll failed
     */
    Error deleteAll() noexcept;

    /**
     * @brief Get all key-values pairs for the corresponding partition
     *
     * @param partition Partition name
     * @return Error if operation failed
     */
    virtual ErrorOr<Values> getAll(TextView partition) noexcept = 0;

    /**
     * @brief Copy all key-values pairs from source partition to the destition
     * partition
     *
     * @param srcPartition Source partition name
     * @param destPartition Destination partition name
     * @return Error if operation failed
     */
    virtual Error copyAll(TextView srcPartition,
                          TextView destPartition) noexcept = 0;

    /**
     * @brief Advanced copy from source partition to the destination partition
     *
     * `moveAll` implementation should have next logic:
     *  - if source partition is empty, and `skipEmptySource` is set - nothing
     * is done;
     *  - if `deleteDest` is set, then `destPartition` is clean before copy;
     *  - copy everything from source partition to the destination one.
     * This logic is synced by APP side also, and all implementation of this
     * function should support this logic
     *
     * @param srcPartition name of the source partition
     * @param destPartition name of the destination partition
     * @param deleteDest delete everything from destination before move
     * @param skipEmptySource Do nothing if source is empty
     * @return Error if operation failed
     */
    virtual Error moveAll(TextView srcPartition, TextView destPartition,
                          bool deleteDest, bool skipEmptySource) noexcept = 0;

protected:
    Url m_Url;
};

}  // namespace engine::keystore
