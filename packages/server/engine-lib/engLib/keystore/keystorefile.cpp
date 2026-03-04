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

#include <engLib/eng.h>

using namespace engine::net::rpc::v3::keystore;

namespace engine::keystore {

/**
 * @brief Dectructor
 */
KeyStoreFile::~KeyStoreFile() noexcept {
    auto lock{m_lock.writeLock()};
    dump();
}

/**
 * @brief Open the key store
 *
 * @param url Url to open, it should point to the JSON file
 * @return Error if open failed
 */
Error KeyStoreFile::open(const Url &url) noexcept {
    auto lock{m_lock.writeLock()};

    if (m_inited) return APERRT(Ec::AlreadyOpened, "already opened");

    load(url);

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
ErrorOr<Text> KeyStoreFile::getValue(TextView partition,
                                     TextView key) noexcept {
    auto lock{m_lock.readLock()};
    if (!m_inited) return APERRT(Ec::NotOpen, "not opened");
    Text result;
    if (m_db.isMember(partition) && m_db[partition].isMember(key))
        result = m_db[partition][key].asString();
    return result;
}

/**
 * @brief Set value for the key inside the corresponding partition
 *
 * @param partition Partition name
 * @param key Key name
 * @param value Value to set
 * @return Error if set failed
 */
Error KeyStoreFile::setValue(TextView partition, TextView key,
                             TextView value) noexcept {
    auto lock{m_lock.writeLock()};
    if (!m_inited) return APERRT(Ec::NotOpen, "not opened");
    m_db[partition][key] = value;
    return {};
}

/**
 * @brief Delete the corresponding key from the corresponding partition
 *
 * @param partition Partition name
 * @param key Key name
 * @return Error if delete failed
 */
Error KeyStoreFile::deleteKey(TextView partition, TextView key) noexcept {
    auto lock{m_lock.writeLock()};
    if (!m_inited) return APERRT(Ec::NotOpen, "not opened");
    Text result;
    if (m_db.isMember(partition) && m_db[partition].isMember(key))
        m_db[partition].removeMember(key);
    return {};
}

/**
 * @brief Delete everything from the corresponding partition
 *
 * @param partition Partition name
 * @return Error if deleteAll failed
 */
Error KeyStoreFile::deleteAll(TextView partition) noexcept {
    auto lock{m_lock.writeLock()};
    if (!m_inited) return APERRT(Ec::NotOpen, "not opened");
    if (m_db.isMember(partition)) m_db[partition].clear();
    return {};
}

/**
 * @brief Get all key-values pairs for the corresponding partition
 *
 * @param partition Partition name
 * @return Error if operation failed
 */
ErrorOr<KeyStore::Values> KeyStoreFile::getAll(TextView partition) noexcept {
    KeyStore::Values result;
    auto lock{m_lock.readLock()};
    if (!m_inited) return APERRT(Ec::NotOpen, "not opened");
    if (m_db.isMember(partition)) {
        const auto &keys = m_db[partition];
        for (const auto &key : keys.getMemberNames())
            result[key] = keys[key].asString();
    }

    return result;
}

/**
 * @brief Copy all key-values pairs from source partition to the destition
 * partition
 *
 * @param srcPartition Source partition name
 * @param destPartition Destination partition name
 * @return Error if operation failed
 */
Error KeyStoreFile::copyAll(TextView srcPartition,
                            TextView destPartition) noexcept {
    auto lock{m_lock.writeLock()};
    if (!m_inited) return APERRT(Ec::NotOpen, "not opened");
    if (m_db.isMember(srcPartition)) {
        const auto &keys = m_db[srcPartition];
        for (const auto &key : keys.getMemberNames())
            m_db[destPartition][key] = keys[key].asString();
    }

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
Error KeyStoreFile::moveAll(TextView srcPartition, TextView destPartition,
                            bool deleteDest, bool skipEmptySource) noexcept {
    auto lock{m_lock.writeLock()};
    if (!m_inited) return APERRT(Ec::NotOpen, "not opened");
    if (m_db.isMember(srcPartition)) {
        auto &keys = m_db[srcPartition];

        // do nothing if source is empty && corresponding flag is set
        if (keys.size() == 0 && skipEmptySource) return {};

        // delete everything from the destination if corresponding flag is set
        if (deleteDest && m_db.isMember(destPartition))
            m_db[destPartition].clear();

        for (const auto &key : keys.getMemberNames())
            m_db[destPartition][key] = keys[key].asString();

        keys.clear();
    }

    return {};
}

/**
 * @brief Dump key-store into JSON file.
 *
 * @return Error if dump failed
 */
Error KeyStoreFile::dump() noexcept {
    if (m_db.isNull()) return {};

    // Get the file name
    auto errorOrLocalPath =
        engine::stream::keystorefile::KeyStoreFile::localPath(m_url);
    if (errorOrLocalPath.hasCcode()) return errorOrLocalPath.ccode();
    auto path = errorOrLocalPath.value();

    // Log some status
    LOGT("Saving", path);

    // Convert to a string
    auto content = m_db.stringify(true);

    // Save it
    return file::put(path, content);
}

/**
 * @brief Load key-store from the JSON file
 *
 * @param url URL to load data from
 * @return Error if load failed
 */
Error KeyStoreFile::load(const Url &url) noexcept {
    auto errorOrLocalPath =
        engine::stream::keystorefile::KeyStoreFile::localPath(url);
    if (errorOrLocalPath.hasCcode()) return errorOrLocalPath.ccode();
    auto path = errorOrLocalPath.value();

    // Log some status
    LOGT("Loading", path);

    // Load it, parse it
    auto contents = file::fetchString(path);
    if (!contents) {
        if (contents.ccode() == ENOENT) {
            m_db = json::Value(json::objectValue);
            m_url = url;
            m_inited = true;
            return {};
        }
        return APERR(contents.ccode(), "Failed to load file", path);
    }

    // Parse it into json
    auto database = json::parse(*contents);
    if (!database) return APERR(database.ccode(), "Failed to parse file", path);

    // Save it and done
    m_db = _mv(*database);
    m_url = url;
    m_inited = true;

    return {};
}

}  // namespace engine::keystore
