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

namespace engine::store {

_const auto StateKey = "sync-tokens.state"_tv;
_const auto ConfigurationKey = "selection.configuration-hash"_tv;
_const auto StateTokenFamily = "sync-tokens.state"_tv;
_const auto PendingTokenFamily = "sync-tokens.pending"_tv;
_const auto BackupTokenFamily = "sync-tokens.backup"_tv;

//-------------------------------------------------------------------------
/// @details
///		Indicates whether the endpoint supports sync tokens
//-------------------------------------------------------------------------
bool IServiceEndpoint::isSyncEndpoint() noexcept {
    // Get protocol
    auto scanProtocol = config.serviceConfig.lookup<Text>("type");

    // Get the capability flags of this protocol
    uint32_t caps = 0;
    if (Url::getCaps(scanProtocol.toView(), caps)) return false;

    return 0 != (caps & Url::PROTOCOL_CAPS::SYNC);
}

ErrorOr<SYNC_SCAN_STATE> IServiceEndpoint::getSyncState() noexcept {
    if (auto ccode = isKeyStoreInitialized()) return ccode;

    auto state = m_keyStore->getValue(StateKey);
    if (state.hasCcode()) {
        return state.ccode();
    }

    // if no key
    if ((*state).empty()) return SYNC_SCAN_STATE::STATE;

    return _fs<SYNC_SCAN_STATE>(*state);
}

Error IServiceEndpoint::setSyncState(SYNC_SCAN_STATE state) noexcept {
    if (auto ccode = isKeyStoreInitialized()) return ccode;

    return m_keyStore->setValue(StateKey, _ts(state));
}

Error IServiceEndpoint::beginSyncScan(TextView configurationToken) noexcept {
    auto state = getSyncState();
    if (state.hasCcode()) return state.ccode();

    // do not check for m_keyStore -> it is checked above in the `getSyncState`
    if (*state != SYNC_SCAN_STATE::STATE) {
        LOG(Always, "WARNING: Invalid token storage state:", state);

        // Delete pending tokens
        if (auto ccode = m_keyStore->deleteAll(PendingTokenFamily))
            return ccode;

        if (auto ccode = m_keyStore->moveAll(BackupTokenFamily,
                                             StateTokenFamily, true, true))
            return ccode;
    }

    LOGT("State", *state, "->", SYNC_SCAN_STATE::SCANNING);
    if (auto ccode = setSyncState(SYNC_SCAN_STATE::SCANNING)) return ccode;

    // Get current configuration token
    Text currentConfigurationToken;
    if (auto value = getSyncToken(ConfigurationKey); value.hasCcode()) {
        return value.ccode();
    } else {
        if (!(*value).empty()) currentConfigurationToken = _mv(*value);
    }

    // Check whether the configuration changed
    if (currentConfigurationToken != configurationToken) {
        // Backup state tokens
        if (auto ccode = m_keyStore->moveAll(StateTokenFamily,
                                             BackupTokenFamily, true, false))
            return ccode;
    }

    // Set configuration token as pending
    if (auto ccode = setSyncToken(ConfigurationKey, configurationToken))
        return ccode;

    return {};
}

Error IServiceEndpoint::endSyncScan() noexcept {
    auto state = getSyncState();
    if (state.hasCcode()) return state.ccode();

    if (*state != SYNC_SCAN_STATE::SCANNING)
        return APERRT(Ec::InvalidState, "Invalid state:", *state);

    LOGT("State", *state, "->", SYNC_SCAN_STATE::SCANNED);
    if (auto ccode = setSyncState(SYNC_SCAN_STATE::SCANNED)) return ccode;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///	    Get token for specified key
//-------------------------------------------------------------------------
ErrorOr<Text> IServiceEndpoint::getSyncToken(TextView key) noexcept {
    if (auto ccode = isKeyStoreInitialized()) return ccode;
    // get state token
    return m_keyStore->getValue(StateTokenFamily, key);
}

//-------------------------------------------------------------------------
/// @details
///		Set token for specified key
//-------------------------------------------------------------------------
Error IServiceEndpoint::setSyncToken(TextView key, TextView value) noexcept {
    if (auto ccode = isKeyStoreInitialized()) return ccode;
    // set token as pending
    return m_keyStore->setValue(PendingTokenFamily, key, value);
}

//-----------------------------------------------------------------
/// @details
///		Perform a commit of the sync tokens saved by the last
///     scan by sync endpoint.
//-----------------------------------------------------------------
Error IServiceEndpoint::commitScan() noexcept {
    // Validate if sync tokens supported
    if (!isSyncEndpoint()) {
        // SDK (test tasks) run commitScan in all cases,
        // so just skip if sync tokens not supported
        LOGT("commitScan skipped: The", config.logicalType,
             "service does not support sync tokens");
        return {};
    }

    if (config.openMode != OPEN_MODE::SCAN)
        return APERR(Ec::NotSupported,
                     "Committing sync tokens is not supported in",
                     _ts(config.openMode), "mode");

    // also checks for valid keystore
    auto state = getSyncState();
    if (state.hasCcode()) return state.ccode();

    // Skip if already committed
    if (*state == SYNC_SCAN_STATE::STATE) {
        LOG(Always, "WARNING: Token storage already committed");
        return {};
    }

    // Fail if the state is invalid
    if (*state != SYNC_SCAN_STATE::SCANNED)
        return APERRT(Ec::InvalidState, "Invalid state:", *state);

    // Update state tokens with corresponding pending tokens
    if (auto ccode = m_keyStore->copyAll(PendingTokenFamily, StateTokenFamily))
        return ccode;

    // Delete state tokens those have no corresponding pending tokens
    size_t commitTokenCount = 0, obsoleteTokenCount = 0;
    ErrorOr<keystore::KeyStore::Values> errorOrValues =
        m_keyStore->getAll(StateTokenFamily);
    if (errorOrValues.hasCcode()) return errorOrValues.ccode();
    keystore::KeyStore::Values stateTokenValues = *errorOrValues;
    errorOrValues = m_keyStore->getAll(PendingTokenFamily);
    if (errorOrValues.hasCcode()) return errorOrValues.ccode();
    keystore::KeyStore::Values pendingTokenValues = *errorOrValues;

    for (auto it = stateTokenValues.begin(); it != stateTokenValues.end();
         ++it) {
        const auto &key = it->first;
        auto itPending = pendingTokenValues.find(key);
        if (itPending == pendingTokenValues.end()) {
            if (auto ccode = m_keyStore->deleteKey(StateTokenFamily, key))
                return ccode;
            ++obsoleteTokenCount;
        } else {
            ++commitTokenCount;
        }
    }

    // Finally delete pending and backup tokens
    if (auto ccode = m_keyStore->deleteAll(PendingTokenFamily) ||
                     m_keyStore->deleteAll(BackupTokenFamily))
        return ccode;

    LOGT("State", *state, "->", SYNC_SCAN_STATE::STATE);
    if (auto ccode = setSyncState(SYNC_SCAN_STATE::STATE)) return ccode;

    MONITOR(status, _ts("commitScan: ", commitTokenCount, " token committed, ",
                        obsoleteTokenCount, " token removed"));

    return {};
}

//-----------------------------------------------------------------
/// @details
///		Deletes all the sync tokens of the sync endpoint.
//-----------------------------------------------------------------
Error IServiceEndpoint::resetScan() noexcept {
    // Validate if sync tokens supported
    if (!isSyncEndpoint())
        return APERR(Ec::NotSupported, "The", config.logicalType,
                     "service does not support sync tokens");

    if (auto ccode = isKeyStoreInitialized()) return ccode;

    return m_keyStore->deleteKey(StateKey) ||
           m_keyStore->deleteAll(StateTokenFamily) ||
           m_keyStore->deleteAll(PendingTokenFamily) ||
           m_keyStore->deleteAll(BackupTokenFamily);
}

//-----------------------------------------------------------------
/// @details
///     Checks whether the keystore is initialized.
//-----------------------------------------------------------------
Error IServiceEndpoint::isKeyStoreInitialized() const noexcept {
    return m_keyStore ? Error()
                      : APERR(Ec::InvalidKeyStore,
                              "Key store required, and is not specified");
}

}  // namespace engine::store
