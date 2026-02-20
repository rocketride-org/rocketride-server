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

template <typename T>
inline Error checkReply(const ErrorOr<T> &reply) noexcept;

/**
 * @brief Open the key store
 *
 * @param url Url to open, it should point to APP endpoint
 * @return Error if open failed
 */
Error KeyStoreNet::open(const Url &url) noexcept {
    if (m_cxn) return APERRT(Ec::AlreadyOpened, "already opened");

    net::TlsConnection::Options tlsOptions;

    // Get the secure flag to determine if we are running secure or not
    bool isSecure = url.lookup<bool>("secure");

    // If we are secure, then pull the tls options from the url query params
    if (isSecure) {
        // Grab the tls options
        tlsOptions = _fjc<net::TlsConnection::Options>(url.queryParams());
    }

    // Allocate the connection
    m_cxn = makeUnique<net::rpc::Connection>();
    if (!m_cxn) return APERR(Ec::InvalidRpc, "Unable to create a connection");

    // Now, connect it
    if (auto ccode =
            m_cxn->connect(url.host(), url.port(), isSecure, tlsOptions))
        return ccode;

    // update url
    m_Url = url;

    return {};
}

/**
 * @brief Get value of the key for the corresponding partition
 *
 * @param partition Partition name
 * @param key Key name
 * @return Value of the corresponding key inside the corresponding partition, or
 * error
 */
ErrorOr<Text> KeyStoreNet::getValue(TextView partition, TextView key) noexcept {
    if (!m_cxn) return APERRT(Ec::NotOpen, "not opened");

    auto reply = m_cxn->submit<Get>(partition, key);
    if (auto ccode = checkReply(reply)) return ccode;

    return _mv(reply->data.value);
}

/**
 * @brief Set value for the key inside the corresponding partition
 *
 * @param partition Partition name
 * @param key Key name
 * @param value Value to set
 * @return Error if set failed
 */
Error KeyStoreNet::setValue(TextView partition, TextView key,
                            TextView value) noexcept {
    if (!m_cxn) return APERRT(Ec::NotOpen, "not opened");

    auto reply = m_cxn->submit<Set>(partition, key, value);
    if (auto ccode = checkReply(reply)) return ccode;

    return {};
}

/**
 * @brief Delete the corresponding key from the corresponding partition
 *
 * @param partition Partition name
 * @param key Key name
 * @return Error if delete failed
 */
Error KeyStoreNet::deleteKey(TextView partition, TextView key) noexcept {
    if (!m_cxn) return APERRT(Ec::NotOpen, "not opened");

    auto reply = m_cxn->submit<Delete>(partition, key);
    if (auto ccode = checkReply(reply)) return ccode;

    return {};
}

/**
 * @brief Delete everything from the corresponding partition
 *
 * @param partition Partition name
 * @return Error if deleteAll failed
 */
Error KeyStoreNet::deleteAll(TextView partition) noexcept {
    if (!m_cxn) return APERRT(Ec::NotOpen, "not opened");

    auto reply = m_cxn->submit<DeleteAll>(partition);
    if (auto ccode = checkReply(reply)) return ccode;

    return {};
}

/**
 * @brief Get all key-values pairs for the corresponding partition
 *
 * @param partition Partition name
 * @return Error if operation failed
 */
ErrorOr<KeyStore::Values> KeyStoreNet::getAll(TextView partition) noexcept {
    if (!m_cxn) return APERRT(Ec::NotOpen, "not opened");

    auto reply = m_cxn->submit<GetAll>(partition);
    if (auto ccode = checkReply(reply)) return ccode;

    return _mv(reply->data.values);
}

/**
 * @brief Copy all key-values pairs from source partition to the destition
 * partition
 *
 * @param srcPartition Source partition name
 * @param destPartition Destination partition name
 * @return Error if operation failed
 */
Error KeyStoreNet::copyAll(TextView srcPartition,
                           TextView destPartition) noexcept {
    if (!m_cxn) return APERRT(Ec::NotOpen, "not opened");

    auto reply = m_cxn->submit<CopyAll>(srcPartition, destPartition);
    if (auto ccode = checkReply(reply)) return ccode;

    return {};
}

/**
 * @brief Advanced copy from source partition to the destination partition
 *
 * `moveAll` implementation should have next logic:
 *  - if source partition is empty, and `skipEmptySource` is set - nothing is
 * done;
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
Error KeyStoreNet::moveAll(TextView srcPartition, TextView destPartition,
                           bool deleteDest, bool skipEmptySource) noexcept {
    if (!m_cxn) return APERRT(Ec::NotOpen, "not opened");

    auto reply = m_cxn->submit<MoveAll>(srcPartition, destPartition, deleteDest,
                                        skipEmptySource);
    if (auto ccode = checkReply(reply)) return ccode;

    return {};
}

/**
 * @brief Check reply
 *
 * @param reply Reply from the APP
 * @return Error if reply is incorrect
 */
template <typename T>
inline Error checkReply(const ErrorOr<T> &reply) noexcept {
    if (reply.hasCcode()) return reply.ccode();
    if (reply->status != "OK")
        return APERR(Ec::RequestFailed,
                     "RPC request failed: reply status:", reply->status);
    return {};
}

}  // namespace engine::keystore
