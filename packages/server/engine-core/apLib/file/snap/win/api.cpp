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

#include <apLib/ap.h>

namespace ap::file::snap {

// Creates a snap context for all volumes on system
ErrorOr<Context> create(bool persist) noexcept {
    auto roots = loadRoots();
    if (!roots) return roots.ccode();
    return create(*roots, persist);
}

// Creates a snap context for a specific list of paths
ErrorOr<Context> create(const std::vector<file::Path> &paths,
                        bool persist) noexcept {
    Context ctx;

    if (paths.empty()) return ctx;

    // Setup a vss client
    auto &client = ctx.client.emplace();
    if (auto ccode = client.init(persist)) return ccode;

    LOG(Snap, "Creating {} snapshot for paths",
        persist ? "persistent" : "temporary", _tsd<'\n'>(paths));

    // Get all the unique volumes we need to snap
    PathMap pathMap;
    for (auto &path : paths) {
        // See if we can get its volume
        Path mountPoint;
        auto volume = getVolumeNameFromPath(path, mountPoint);
        if (!volume)
            return APERRL(Snap, volume.ccode(),
                          "Failed to get volume mount path", path);

        LOG(Snap, "Mapped volume mount name {} => {} => {}", path, mountPoint,
            volume);

        pathMap[_mv(*volume)] = _mv(mountPoint);
    }

    if (auto ccode = client.startSnapset()) return ccode;

    // Add all the requested volumes to the snapshot list
    for (auto &[vol, mountPoint] : pathMap) {
        LOG(Snap, "Adding volume to snap set", vol);

        if (auto ccode = client.add(vol)) return ccode;
    }

    // Start snapshot
    if (auto ccode = client.doSnapshot()) return ccode;

    // Now list all snapshots, any that we added add to the resulting map
    auto snaps = client.list();
    if (!snaps) return snaps.ccode();
    for (auto &&[vol, snap] : *snaps) {
        // Locate the original volume
        auto iter = pathMap.find(vol);
        if (iter == pathMap.end())
            return APERRL(Snap, Ec::NotFound,
                          "Failed to locate volume in snapshot set", vol[0]);

        ctx.vols[snap] = vol[0];

        // Now add it to the map, this maps Volume{GUID} =>
        // GLOBALROOT/Device/HarddiskVolumeShadowCopy18
        auto &target = ctx.snaps[vol[0]] = _mv(snap);
        LOG(Snap, "Added snapshot map {} => {}", vol[0], target);

        // And update the mounts, this maps s:/ => Volume{GUID}
        ctx.mounts[iter->second] = iter->first.at(0);
    }

    return ctx;
}

// List all persistent snapshots on the system
ErrorOr<Context> list(bool persist) noexcept {
    LOG(Snap, "Listing", persist);

    if (auto ccode = plat::ComInit::init()) return ccode;

    Context ctx;
    auto &client = ctx.client.emplace();
    if (auto ccode = client.init(persist)) return ccode;

    auto snaps = client.list();
    if (!snaps) return snaps.ccode();
    for (auto &&[vol, snap] : *snaps) {
        LOG(Snap, "Listed {} => {}", vol[0], snap);
        ctx.snaps[vol[0]] = _mv(snap);
    }

    if (auto ccode = buildMaps(ctx.snaps, ctx.vols, ctx.mounts)) return ccode;

    return ctx;
}

// Given a list of snapshots, builds a mount map
Error buildMaps(const SnapMap &snaps, VolMap &vols, MountMap &mounts) noexcept {
    mounts.clear();
    vols.clear();
    for (auto &[vol, snap] : snaps) {
        VolumeMountPointScanner scanner(vol);
        vols[snap] = vol;
        if (auto ccode = scanner.open())
            return APERRL(Snap, ccode,
                          "Failed to scan for mount points on snapshot", vol,
                          snap);
        while (auto mount = scanner.next()) {
            LOG(Snap, "Adding mount {} => {}", mount, vol);
            mounts[_mv(*mount)] = vol;
        }
    }
    return {};
}

// Map a path from, or to a snap path
Path map(const Context &ctx, const Path &path) noexcept {
    if (path.isSnap()) {
        auto snap = path.subpth(0, 3);
        auto volName = ctx.vols.find(snap);
        ASSERTD_MSG(volName != ctx.vols.end(),
                    "Request to map missing snap path", snap);

        for (auto &[mount, vol] : ctx.mounts) {
            if (vol == volName->second) {
                // Finally we can now compose a new path
                auto res = mount / path.subpth(3);
                LOG(Snap, "Map {} => {}", path, res);
                return res;
            }
        }
        dev::fatality(_location, "Request to map missing vol name",
                      volName->second);
    } else {
        // First determine its volume name from its path
        // e.g. s:/text.txt => s:/
        auto mountPath = getVolumePathName(path);
        if (!mountPath) return path;

        // Next lookup its volume uuid in the mount map
        auto volName = ctx.mounts.find(*mountPath);
        if (volName == ctx.mounts.end()) {
            LOG(Snap, "Failed to map: {} mounts: {}", mountPath, ctx.mounts);
            return path;
        }

        // Finally from the volume name, lookup its snapshot path
        auto iter = ctx.snaps.find(volName->second);
        if (iter == ctx.snaps.end()) {
            LOG(Snap, "Failed to map: {} snaps: {}", path, ctx.snaps);
            return path;
        }

        // Finally we can now compose a new path
        auto res = iter->second / path.subpth(1);
        LOG(Snap, "Map {} => {}", path, res);
        return res;
    }
}

void detach(Context &ctx) noexcept {
    LOG(Snap, "Detaching context", ctx);

    if (ctx.client) ctx.client->detach();
}

Error destroy(Context &ctx) noexcept {
    LOG(Snap, "Destroying context", ctx);

    if (ctx.client && ctx.client->attached()) return ctx.client->destroy();

    return VssClient::destroy(ctx.snaps);
}

}  // namespace ap::file::snap
