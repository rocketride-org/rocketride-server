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

#include <unicode/unistr.h>

namespace engine::store::filter::azure {
inline Text renderUid(Text uid) noexcept { return _fmt("U:{}", uid); }
inline Text renderGid(Text uid) noexcept { return _fmt("G:{}", uid); }
inline ErrorOr<TextView> parseId(TextView string) noexcept {
    return string.substr(2);
}

//-----------------------------------------------------------------
/// @details
///		Map an Id and create an entry for it in the global
///		data if needed
///	@param[in]	idStr
///		The Id to map
/// @param[in|out]	mappedIds
///		The returned structure with a computed hash.
///	@returns
///		Error
//-----------------------------------------------------------------
Error IFilterInstance::mapId(TextView idStr,
                             std::unordered_set<Text> &mappedIds) noexcept {
    using namespace perms;
    using namespace string::icu;
    if (!idStr) return {};

    if (mappedIds.find(idStr) != mappedIds.end()) return {};

    // Insert the ID regardless of whether it can be mapped so we don't keep
    // trying to map the same bad ID
    mappedIds.insert(idStr);

    switch (idStr[0]) {
        case 'U': {
            auto uid = parseId(idStr);
            if (!uid) {
                MONERR(error, uid.ccode(), "Failed to parse UID", idStr);
                return {};
            }
#if ROCKETRIDE_PLAT_WIN
            auto name = _tr<Utf16>(Text(uid.value()));
#else
            auto name = uid.value();
#endif
            UserRecord userRecord{
                .id = idStr, .local = true, .authority = {}, .name = name};
            endpoint.permissionInfo.add(userRecord);
            return {};
        }

        case 'G': {
            auto gid = parseId(idStr);
            if (!gid) {
                MONERR(error, gid.ccode(), "Failed to parse GID", idStr);
                return {};
            }
#if ROCKETRIDE_PLAT_WIN
            auto name = _tr<Utf16>(Text(gid.value()));
#else
            auto name = gid.value();
#endif
            GroupRecord group{
                .id = idStr, .local = true, .authority = {}, .name = name};

            endpoint.permissionInfo.add(group);
            return {};
        }

        default: {
            MONERR(error, Ec::InvalidParam, "Failed to parse ID", idStr);
            return {};
        }
    }
};

//-----------------------------------------------------------------
/// @details
///		Calculate owner and permissions for each Object.
///	@param[in]	entry
///		The object
///	@returns
///		Error
//-----------------------------------------------------------------
Error IFilterInstance::getPermissions(Entry &entry) noexcept {
    LOGT("Checking for Permissions Azure object '{}'", entry.fileName());
    // Clear entry fields in case we fail
    entry.permissionId.reset();
    using namespace engine::perms;
    Path path;
    if (auto ccode = Url::toPath(entry.url(), path)) return ccode;
    auto errorOr = endpoint.getAccessPolicy(path);
    if (errorOr.hasCcode()) return errorOr.ccode();
    auto permsValues = errorOr.value();

    PermissionSet permSet;
    for (const auto &signedIdentifier : permsValues.SignedIdentifiers) {
        if (const auto rights = getRights(signedIdentifier.Permissions)) {
            if (hasAllRights(signedIdentifier.Permissions)) {
                permSet.ownerId = renderUid(signedIdentifier.Id);
                permSet.perms.insert(
                    Permission{.principalId = renderUid(signedIdentifier.Id),
                               .rights = rights.value()});
                // do not add as permission
                continue;
            }

            permSet.perms.insert(
                Permission{.principalId = renderGid(signedIdentifier.Id),
                           .rights = rights.value()});
        }
    }

    // Treat a file as failed if we weren't able to determine owner or rights
    if (permSet.empty())
        return APERRT(Ec::NoPermissions, "No mappable rights found for file",
                      entry);

    // Add the permissions and get a set number
    auto permSetId = endpoint.permissionInfo.add(_mv(permSet));

    // Save them into the entry
    entry.permissionId(permSetId);
    return {};
}

ErrorOr<std::list<Text>> IFilterInstance::outputPermissions() noexcept {
    if (!endpoint.permissionInfo.size()) return {};

    const auto permsList = endpoint.permissionInfo.build();
    MONITOR(status, "Preparing principals");
    std::unordered_set<Text> mappedIds;

    // map all principals
    // continue processing even if `mapId` returns an error
    for (const auto &permSet : permsList) {
        Error ccode = mapId(permSet.ownerId, mappedIds);

        // Map it
        for (const auto &perm : permSet.perms) {
            ccode = mapId(perm.principalId, mappedIds);
        }
    }

    return endpoint.outputPermissions();
}

}  // namespace engine::store::filter::azure
