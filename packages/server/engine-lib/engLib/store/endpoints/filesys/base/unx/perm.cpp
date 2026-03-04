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

namespace engine::store::filter::filesys::base {
template <log::Lvl LvlT>
class IBaseEndpoint;
}

namespace engine::permission {

//-----------------------------------------------------------------
/// @details
///		Get effective permissions of an entry
///	@param[in]	fileStat
///		entry permissions
/// @param[in]	path
///		The returned structure with a computed hash.
/// @param[in|out] endpoint
///		filesystem endpoint
///	@returns
///		ErrorOr<int>, effective permissions
//-----------------------------------------------------------------
template <log::Lvl LvlT>
ErrorOr<int> permissions::getEffectivePermissions(
    struct stat &entryStat, const Text &path,
    store::filter::filesys::base::IBaseEndpoint<LvlT> &endpoint) noexcept {
    int permission = 0;
    int owner = entryStat.st_uid;
    int group = entryStat.st_gid;

    permission = entryStat.st_mode;

    Text parentPath = path;
    Text filePath = path;
    size_t pos = filePath.size();

    // position to keep track of last '/'
    pos = filePath.find_last_of('/', pos - 1);
    if (pos != Text::npos) {
        filePath.erase(pos + 1);  // Keep the '/' in the path
    }

    // get permissions for all parents and grandparents
    // In linux, if a user or a group doesn't have a execute permission on a
    // folder (traversal permission) then the group or the user has no access to
    // the file even if the user is the owner
    while (pos != 0 && pos != Text::npos) {
        parentPath = filePath;

        // Get the owner and group of the parent directory
        struct stat parentSt;

        // Owner and group are already present
        {
            auto lock = endpoint.m_permissionLock.acquire();
            auto it = endpoint.m_folderPermissions.find(parentPath);
            if (it != endpoint.m_folderPermissions.end()) {
                parentSt = it->second;
            } else {
                {
                    if (stat(parentPath.c_str(), &parentSt) == 0) {
                        endpoint.m_folderPermissions[parentPath] = parentSt;
                    } else {
                        return MONERR(warning, Ec::Warning,
                                      "Could not determine the permissions",
                                      path);
                    }
                }
            }
        }
        int parentOwner = parentSt.st_uid;
        int parentGroup = parentSt.st_gid;

        // S_IRUSR: Read permission for the file owner.
        // S_IWUSR: Write permission for the file owner.
        // S_IXUSR: Execute permission for the file owner.
        // S_IRWXU: Read, write, and search/execute permission for the file
        // owner.

        // S_IRGRP: Read permission for the file's group.
        // S_IWGRP: Write permission for the file's group.
        // S_IXGRP: Execute/search permission for the file's group.
        // S_IRWXG: Read, write, and search/execute permission for the file's
        // group.

        // S_IROTH: Read permission for users other than the file owner.
        // S_IWOTH: Write permission for users other than the file owner.
        // S_IXOTH: Execute/search permission for users other than the file
        // owner. S_IRWXO: Read, write, and search/execute permission for users
        // other than the file owner.

        // S_ISUID: Set user ID (UID) for execution.
        // S_ISGID: Set group ID (GID) for execution.
        // S_ISVTX: Sticky bit indicating shared text or keeping an executable
        // file in storage.

        bool executeOther = true;
        // check for "Other" execute permission on parent
        if (!(parentSt.st_mode & S_IXOTH)) {
            // Preserve "other" permissions if no execute permission in the
            // parent directory
            permission &= ~S_IRWXO;
            executeOther = false;
        }

        if (owner != parentOwner) {
            // if owner and parentOwner not same, then check traversal
            // permission for others Preserve "other" permissions if no execute
            // permission in the parent directory
            if (!executeOther) permission &= ~S_IRWXU;
        } else {
            // S_IXUSR, bit for the execute for the user
            if (!(parentSt.st_mode & S_IXUSR)) {
                // Preserve "other" permissions if no execute permission in the
                // parent directory
                permission &= ~S_IRWXU;
            }
        }

        if (group != parentGroup) {
            // if group and parentGroup not same, then check traversal
            // permission for others Preserve "other" permissions if no execute
            // permission in the parent directory S_IRWXG, bit for the execute,
            // read and write for the group
            if (!executeOther) permission &= ~S_IRWXG;
        } else {
            // S_IXGRP, bit for the execute for the group
            if (!(parentSt.st_mode & S_IXGRP)) {
                // Preserve "other" permissions if no execute permission in the
                // parent directory
                permission &= ~S_IRWXG;
            }
        }

        pos = filePath.find_last_of('/', pos - 1);
        if (pos != Text::npos) {
            filePath.erase(pos + 1);  // Keep the '/' in the path
        }
    }
    return permission;
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
Error permissions::mapId(
    TextView idStr, std::unordered_set<Text> &mappedIds,
    perms::PermissionInformation &permissionInfo) noexcept {
    using namespace perms;

    if (!idStr) return {};

    if (mappedIds.find(idStr) != mappedIds.end()) return {};

    // Insert the ID regardless of whether it can be mapped so we don't keep
    // trying to map the same bad ID
    mappedIds.insert(idStr);

    switch (idStr[0]) {
        case 'U': {
            auto uid = parseUid(idStr);
            if (!uid) {
                MONERR(error, uid.ccode(), "Failed to parse UID", idStr);
                return {};
            }

            auto username = getUsername(*uid);
            if (!username) {
                MONERR(warning, username.ccode(), "Unable to map UID", idStr);
                return {};
            }

            UserRecord userRecord{
                .id = idStr, .local = true, .authority = {}, .name = *username};
            permissionInfo.add(userRecord);
            break;
        }

        case 'G': {
            auto gid = parseGid(idStr);
            if (!gid) {
                MONERR(error, gid.ccode(), "Failed to parse GID", idStr);
                return {};
            }

            GroupRecord group{.id = idStr, .local = true, .authority = {}};

            std::vector<Text> memberIds;
            auto groupName = perms::expandGroup(
                *gid, [&](const struct passwd &member) noexcept -> Error {
                    const auto formattedMemberId = renderUid(member);
                    if (auto ccode =
                            mapId(formattedMemberId, mappedIds, permissionInfo))
                        return ccode;

                    group.memberIds.emplace_back(_mv(formattedMemberId));
                    return {};
                });

            if (!groupName) {
                if (groupName.ccode() == Ec::NotFound)
                    MONERR(warning, groupName.ccode(), "Group not found",
                           idStr);
                else
                    MONERR(warning, groupName.ccode(), "Unable to expand group",
                           idStr);
                return {};
            }

            group.name = *groupName;
            permissionInfo.add(group);
            break;
        }

        default: {
            MONERR(error, Ec::InvalidParam, "Failed to parse ID", idStr);
        }
    }

    return {};
};

//-----------------------------------------------------------------
/// @details
///		Output the permissions to the output pipe
///	@returns
///		Error
//-----------------------------------------------------------------
template <log::Lvl LvlT>
ErrorOr<std::list<Text>> permissions::outputPermissions(
    perms::PermissionInformation &permissionInfo,
    store::filter::filesys::base::IBaseEndpoint<LvlT> &endpoint) noexcept {
    const auto permsList = permissionInfo.build();
    MONITOR(status, "Preparing principals");
    std::unordered_set<Text> mappedIds;

    // map all principals
    // continue processing even if `mapId` returns an error
    for (const auto &permSet : permsList) {
        Error ccode = mapId(permSet.ownerId, mappedIds, permissionInfo);

        // Map it
        for (const auto &perm : permSet.perms) {
            ccode = mapId(perm.principalId, mappedIds, permissionInfo);
        }
    }

    return endpoint.outputPermissions();
}

//-----------------------------------------------------------------
/// @details
/// 	Calculate owner and group permissions for each file.
/// 	Users are identified by UID and groups by GID, which are
///		both just ints.  User and group identifiers can collide,
///		though, so we prefix UID's with "U:" and GID's with "G:",
///		e.g. "U:0" for root. If a file is owned by the user "nobody"
///		or the group "nogroup", ignore ownership.
///
///		TODO: Query Linux ACL's where supported;
///		see https://linux.die.net/man/3/acl_get_file
/// 	ACL's are not frequently used, though, and will slow the job down.
///
///	@param[in]	entry
///		The object the permissions of which are computed.
///	@param[in]	osPath
///		The mapped path for the os
///	@returns
///		Error
//-----------------------------------------------------------------
template <log::Lvl LvlT>
Error permissions::getPermissions(
    Entry &entry, Text &osPath, perms::PermissionInformation &permissions,
    store::filter::filesys::base::IBaseEndpoint<LvlT> &endpoint) noexcept {
    using namespace perms;

    LOGT("Getting permissions for", entry);

    // Clear entry fields in case we fail
    entry.permissionId.reset();

    // Map owner Uid
    auto infoOr = ap::file::stat(osPath);
    if (!infoOr) return infoOr.ccode();
    auto info = *infoOr;

    const auto st_uid = info.plat.st_uid;
    const auto st_gid = info.plat.st_gid;
    auto ccode = getEffectivePermissions(info.plat, osPath, endpoint);
    if (ccode.hasCcode()) {
        return ccode.ccode();
    }
    const auto st_mode = ccode.value();

    PermissionSet permSet;
    if (st_uid != cUidNobody) {
        const auto renderedUid = renderUid(st_uid);
        permSet.ownerId = renderedUid;
        if (auto rights = makeOwnerRights(st_mode)) {
            permSet.perms.insert(
                Permission{.principalId = _mv(renderedUid), .rights = rights});
        }
    } else
        LOGT("File is owned by nobody");

    if (st_gid != cGidNoGroup) {
        if (auto rights = makeGroupRights(st_mode)) {
            permSet.perms.insert(
                Permission{.principalId = renderGid(st_gid), .rights = rights});
        }
    } else
        LOGT("File is owned by nogroup");

    // Treat a file as failed if we weren't able to determine owner or rights
    if (permSet.empty())
        return APERRT(Ec::NoPermissions, "No mappable rights found for file",
                      entry);

    // Add the permissions and get a set number
    auto permSetId = permissions.add(_mv(permSet));

    // Save them into the entry
    entry.permissionId(permSetId);

    return {};
}

}  // namespace engine::permission
