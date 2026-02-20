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

#include <engLib/eng.h>

using namespace engine::net::rpc::v3::keystore;

namespace engine::keystore {

/**
 * @brief Constructor
 *
 * Creates the service key-store wrapper around specified key-store with
 * specified `serviceKey`. The `serviceKey` is used as a part of partition name
 * in subsequent calls to the wrapped key-store.
 *
 * @param serviceKey Service key name
 * @param keystore Keystore to wrap
 */
ServiceKeyStore::ServiceKeyStore(TextView serviceKey,
                                 SharedPtr<KeyStore> keystore) noexcept
    : m_serviceKey(serviceKey), m_keystore(keystore) {}

/**
 * @brief Get the URL
 *
 * Calls `getUrl` for the wrapped key store
 *
 * @return The `Url` object
 */
Url ServiceKeyStore::getUrl() const noexcept { return m_keystore->getUrl(); }

/**
 * @brief Open the key store
 *
 * It always returns error
 *
 * @param url Url to open
 * @return Error `Ec::NotSupported`
 */
Error ServiceKeyStore::open(const Url &url) noexcept {
    return APERR(Ec::NotSupported, "not supported");
}

/**
 * @brief Get value of the key for the corresponding partition
 *
 * Calls `getValue` for the wrapped key store
 *
 * @param partition Partition name
 * @param key Key name
 * @return Value of the corresponding key inside the corresponding partition, or
 * error
 */
ErrorOr<Text> ServiceKeyStore::getValue(TextView partition,
                                        TextView key) noexcept {
    return m_keystore->getValue(servicePartition(partition), key);
}

/**
 * @brief Set value for the key inside the corresponding partition
 *
 * Calls `setValue` for the wrapped key store
 *
 * @param partition Partition name
 * @param key Key name
 * @param value Value to set
 * @return Error if set failed
 */
Error ServiceKeyStore::setValue(TextView partition, TextView key,
                                TextView value) noexcept {
    return m_keystore->setValue(servicePartition(partition), key, value);
}

/**
 * @brief Delete the corresponding key from the corresponding partition
 *
 * Calls `deleteKey` for the wrapped key store
 *
 * @param partition Partition name
 * @param key Key name
 * @return Error if delete failed
 */
Error ServiceKeyStore::deleteKey(TextView partition, TextView key) noexcept {
    return m_keystore->deleteKey(servicePartition(partition), key);
}

/**
 * @brief Delete everything from the corresponding partition
 *
 * Calls `deleteAll` for the wrapped key store
 *
 * @param partition Partition name
 * @return Error if deleteAll failed
 */
Error ServiceKeyStore::deleteAll(TextView partition) noexcept {
    return m_keystore->deleteAll(servicePartition(partition));
}

/**
 * @brief Get all key-values pairs for the corresponding partition
 *
 * Calls `getAll` for the wrapped key store
 *
 * @param partition Partition name
 * @return Error if operation failed
 */
ErrorOr<KeyStore::Values> ServiceKeyStore::getAll(TextView partition) noexcept {
    return m_keystore->getAll(servicePartition(partition));
}

/**
 * @brief Copy all key-values pairs from source partition to the destition
 * partition
 *
 * Calls `copyAll` for the wrapped key store
 *
 * @param srcPartition Source partition name
 * @param destPartition Destination partition name
 * @return Error if operation failed
 */
Error ServiceKeyStore::copyAll(TextView srcPartition,
                               TextView destPartition) noexcept {
    return m_keystore->copyAll(servicePartition(srcPartition),
                               servicePartition(destPartition));
}

/**
 * @brief Advanced copy from source partition to the destination partition
 *
 * Calls `moveAll` for the wrapped key store
 *
 * @param srcPartition name of the source partition
 * @param destPartition name of the destination partition
 * @param deleteDest delete everything from destination before move
 * @param skipEmptySource Do nothing if source is empty
 * @return Error if operation failed
 */
Error ServiceKeyStore::moveAll(TextView srcPartition, TextView destPartition,
                               bool deleteDest, bool skipEmptySource) noexcept {
    return m_keystore->moveAll(servicePartition(srcPartition),
                               servicePartition(destPartition), deleteDest,
                               skipEmptySource);
}

/**
 * @brief Construct partition name.
 *
 * Service key name is added to the partition name
 *
 * @param partition Partition name
 * @return Text
 */
Text ServiceKeyStore::servicePartition(TextView partition) noexcept {
    return _ts(m_serviceKey, "/", partition);
}

}  // namespace engine::keystore
