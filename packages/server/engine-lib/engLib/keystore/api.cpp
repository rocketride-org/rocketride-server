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

namespace engine::keystore {

/**
 * @brief Opens corresponding key store depending on the protocol.
 *
 * Depending on the type of the passed Url, the corresponding key store is open:
 * - if url's type is `kvsnet`, the `KeyStoreNet` is opened (e.g. the APP)
 * - if url's type is `kvsfile`, the `KeyStoreFile` is opened (e.g. the local
 * file)
 * - otherwise, `InvalidParam` error is returned
 *
 * @param url Url to open
 * @return Pointer to the opened key store, or error
 */
ErrorOr<KeyStorePtr> open(const Url &url) noexcept {
    if (url.protocol() == engine::stream::keystorenet::Type) {
        auto keystore = makeShared<KeyStoreNet>();
        if (auto ccode = keystore->open(url)) return ccode;
        return _cast<KeyStorePtr>(keystore);
    } else if (url.protocol() == engine::stream::keystorefile::Type) {
        auto keystore = makeShared<KeyStoreFile>();
        if (auto ccode = keystore->open(url)) return ccode;
        return _cast<KeyStorePtr>(keystore);
    } else {
        return APERR(Ec::InvalidParam, "Keystore protocol '", url.protocol(),
                     "' not supported");
    }
}

/**
 * @brief Opens corresponding service key store depending on the protocol.
 *
 * Service key store is the wrapper around standard key store, that adds
 * additional level. Depending on the type of the passed Url, the corresponding
 * key store is open:
 * - if url's type is `kvsnet`, the `KeyStoreNet` is opened
 * - if url's type is `kvsfile`, the `KeyStoreFile` is opened
 * - otherwise, `InvalidParam` error is returned
 *
 * @param url Url to open
 * @param serviceKey Service key name
 * @return Pointer to the opened key store, or error
 */
ErrorOr<KeyStorePtr> open(const Url &url, TextView serviceKey) noexcept {
    static WeakPtr<KeyStore> _keystore;

    // if
    //	- already opened
    //	- and relates to the same URL
    // then return it
    auto currentKeyStore = _keystore.lock();
    if (currentKeyStore && currentKeyStore->getUrl() == url) {
        return currentKeyStore;
    }

    ErrorOr<KeyStorePtr> errorOr;
    if (errorOr = open(url), errorOr.hasCcode()) return errorOr;
    KeyStorePtr keystore = *errorOr;

    auto serviceKeyStore = makeShared<ServiceKeyStore>(serviceKey, keystore);
    _keystore = serviceKeyStore;
    return serviceKeyStore;
}

}  // namespace engine::keystore
