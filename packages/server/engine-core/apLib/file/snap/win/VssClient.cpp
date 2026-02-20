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

#include <apLib/ap.h>

namespace ap::file::snap {

VssClient::~VssClient() noexcept {
    // Destroy if we are attached still
    destroy();
}

// Sets up the vss client for basic operation
Error VssClient::init(bool persist) noexcept {
    if (m_backup) return APERRT(Ec::InvalidParam, "Already initialized");

    if (auto ccode = plat::ComInit::init()) return ccode;

    if (auto hr = ::CreateVssBackupComponents(&m_backup); FAILED(hr))
        return APERRT(hr, "CreateVssBackupComponents");

    auto initGuard = util::Guard{[&] { destroy(); }};

    if (auto hr = m_backup->InitializeForBackup(); FAILED(hr))
        return APERRT(hr, "InitializeForBackup");

    m_type = _cast<VSS_SNAPSHOT_CONTEXT>(persist ? PersistedType : TempType);
    if (auto hr = m_backup->SetContext(m_type); FAILED(hr))
        return APERRT(hr, "SetContext");

    initGuard.cancel();

    return {};
}

Error VssClient::startSnapset() noexcept {
    if (m_setId) return APERRT(Ec::InvalidParam, "Snap set already started");
    VSS_ID setId;
    if (auto hr = m_backup->StartSnapshotSet(&setId); FAILED(hr))
        return APERRT(hr, "Failed to start snapset");
    m_setId = setId;
    return {};
}

// Adds a volume path to the snap set
Error VssClient::add(const file::Path& vol) noexcept {
    VSS_ID shadowCopyId;
    if (auto hr = m_backup->AddToSnapshotSet(
            _constCast<WCHAR*>(vol.plat().ptr<WCHAR>()), GUID_NULL,
            &shadowCopyId);
        FAILED(hr))
        return APERRT(hr, "Failed to add volume to snapshot set", vol);
    return {};
}

// Creates the snapshots from volumes added to the snap set
Error VssClient::doSnapshot() noexcept {
    ::CComPtr<IVssAsync> doShadowCopy;
    if (auto hr = m_backup->DoSnapshotSet(&doShadowCopy); FAILED(hr))
        return APERRT(hr, "Failed to do snapshot");

    if (auto hr = doShadowCopy->Wait(); FAILED(hr))
        return APERRT(hr, "Failed to wait for shadow copy");

    return {};
}

// Returns a list of snapshots matching our setup snapshot id
ErrorOr<PathMap> VssClient::list() const noexcept {
    PathMap result;

    ::CComPtr<IVssEnumObject> enumSnapshots;
    if (auto hr = m_backup->Query(GUID_NULL, VSS_OBJECT_NONE,
                                  VSS_OBJECT_SNAPSHOT, &enumSnapshots);
        FAILED(hr))
        return APERRT(hr, "Failed to query snapshots");

    // Enumerate all shadow copies and store VSS volume names we
    // are interested in
    VSS_OBJECT_PROP prop;
    _forever() {
        // Get the next element
        ULONG ulFetched;
        if (auto hr = enumSnapshots->Next(1, &prop, &ulFetched); FAILED(hr))
            return APERRT(hr, "Failed to iterate to next snapshot");

        // We reached the end of list
        if (ulFetched == 0) break;

        // Cleanup properties
        auto guard =
            util::Guard{[&] { ::VssFreeSnapshotProperties(&prop.Obj.Snap); }};

        // If not ours move on
        if (m_setId && *m_setId != prop.Obj.Snap.m_SnapshotSetId) continue;

        // Now register it in our map
        result[prop.Obj.Snap.m_pwszOriginalVolumeName] =
            prop.Obj.Snap.m_pwszSnapshotDeviceObject;
    }

    return result;
}

Error VssClient::destroy() noexcept {
    // Always detach as part of a destroy
    auto detachGuard = util::Guard{[&] { detach(); }};

    // Null op if not bound to a set id
    if (!m_setId) return {};

    // Perform the actual deletion
    LONG lSnapshots = 0;
    VSS_ID idNonDeletedSnapshotID = GUID_NULL;
    HRESULT hr =
        m_backup->DeleteSnapshots(*m_setId, VSS_OBJECT_SNAPSHOT_SET, FALSE,
                                  &lSnapshots, &idNonDeletedSnapshotID);

    m_setId.reset();

    if (FAILED(hr)) return APERRT(hr, "Failed to delete snapset");

    return {};
}

Error VssClient::destroy(const SnapMap& snaps) noexcept {
    // Need a client
    VssClient client;
    if (auto ccode = client.init(true)) return ccode;

    auto destroySnapshotId = [&](auto& id) -> Error {
        // Perform the actual deletion
        LONG lSnapshots = 0;
        VSS_ID idNonDeletedSnapshotID = GUID_NULL;
        auto hr = client.m_backup->DeleteSnapshots(id, VSS_OBJECT_SNAPSHOT,
                                                   FALSE, &lSnapshots,
                                                   &idNonDeletedSnapshotID);

        if (FAILED(hr)) return APERRL(Snap, hr, "Failed to destroy snapshot");
        return {};
    };

    auto destroySnapshot = [&](auto& path) -> Error {
        // Get list all shadow copies.
        CComPtr<IVssEnumObject> enumSnapshots;
        auto hr = client.m_backup->Query(GUID_NULL, VSS_OBJECT_NONE,
                                         VSS_OBJECT_SNAPSHOT, &enumSnapshots);

        if (FAILED(hr)) return APERRL(Snap, hr, "Failed to query snapshots");

        // If there are no shadow copies, just return
        if (hr == S_FALSE) return {};

        // Enumerate all shadow copies. Delete each one
        VSS_OBJECT_PROP prop;
        VSS_SNAPSHOT_PROP& Snap = prop.Obj.Snap;
        _forever() {
            // Get the next element
            ULONG ulFetched;
            hr = enumSnapshots->Next(1, &prop, &ulFetched);
            if (FAILED(hr)) return APERRL(Snap, hr, "Failed to enumerate");

            // We reached the end of list
            if (ulFetched == 0) break;

            // Automatically call VssFreeSnapshotProperties on this structure at
            // the end of scope
            auto clearGuard = util::Guard{
                [&] { ::VssFreeSnapshotProperties(&prop.Obj.Snap); }};

            if (path == Path{Snap.m_pwszOriginalVolumeName}[0]) {
                if (auto ccode = destroySnapshotId(Snap.m_SnapshotId))
                    return ccode;
            }
        }

        return {};
    };

    for (auto& [vol, snap] : snaps) {
        if (auto ccode = destroySnapshot(vol)) return ccode;
    }

    return {};
}

}  // namespace ap::file::snap
