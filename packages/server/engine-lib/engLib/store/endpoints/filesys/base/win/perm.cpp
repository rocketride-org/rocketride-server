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
Text LongUncGen("\\\\?\\UNC\\");

//-----------------------------------------------------------------
/// @details
///		Map a Sid and create an enry for it in the global
///		data if needed
///	@param[in]	sidStr
///		The sid to map
///
///		TThe returned structure with a computed hash.
///	@returns
///		Error
//-----------------------------------------------------------------
Error permissions::mapId(
    TextView sidStr, std::unordered_set<Text> &mappedSids,
    perms::PermissionInformation &permissionInfo) noexcept {
    // If we don't have a sid to map, done
    if (!sidStr) return {};

    // See if we already mapped it
    if (mappedSids.find(sidStr) != mappedSids.end()) return {};

    // Insert the SID regardless of whether it can be mapped so we don't
    // keep trying to map the same bad SID
    mappedSids.insert(sidStr);

    // Get the windows identity for this sid
    auto identity = sidToWindowsIdentity(_fs<perms::Sid>(sidStr), m_systemName);
    if (!identity) {
        MONERR(warning, identity.ccode(), "Unable to map SID", sidStr);
        return {};
    }

    // If this is a group or user sid
    if (identity->isGroup) {
        // Create a group record
        perms::GroupRecord group{
            .id = sidStr,
            .local = identity->type == perms::WindowsIdentity::Type::typeLocal,
            .authority = identity->domain,
            .name = identity->username};

        // Expand the group - Note that the "Domain Users" group will always be
        // empty (see
        // https://stackoverflow.com/questions/525021/domain-users-group-is-empty-when-i-use-directoryservices-member-property)
        auto ccode = perms::expandGroup(
            *identity, [&](const perms::Sid &memberSid) noexcept -> Error {
                // Recursively map the member SID
                auto renderedMemberedSid = _ts(memberSid);
                auto ccode =
                    mapId(renderedMemberedSid, mappedSids, permissionInfo);
                if (ccode) return ccode;

                group.memberIds.emplace_back(renderedMemberedSid);
                return {};
            });

        // Warn if the error is anything other than that the group could not be
        // found
        if (ccode && ccode != Ec::NotFound)
            MONERR(warning, ccode, "Unable to expand group", identity);

        permissionInfo.add(group);
    } else {
        perms::UserRecord userRecord{
            .id = sidStr,
            .local = identity->type == perms::WindowsIdentity::Type::typeLocal,
            .authority = identity->domain,
            .name = identity->username};
        permissionInfo.add(userRecord);
    }

    return {};
}

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

Text ExtractAndRemoveServerName(Text &path) {
    size_t start_pos = path.find(LongUncGen);
    if (start_pos != std::string::npos) {
        start_pos += LongUncGen.length();  // Move past the '\\\\?\\UNC\\'

        size_t end_pos = path.find("\\", start_pos);
        if (end_pos != Text::npos) {
            // Extract server name
            Text serverName = path.substr(start_pos, end_pos - start_pos);
            // Remove server name from path
            path.erase(0, end_pos);
            return serverName;
        }
    }
    return Text();
}

//-----------------------------------------------------------------
/// @details
///		Calculate owner and permissions for each file.
///		In Windows, users are identified via SID's.  For each SID
///		used, map the SID to the corresponding DOMAIN\USER. If the
///		SID cannot be mapped (e.g. it belongs to a deleted user or
///		the domain cannot be reached), don't include it. If the SID
///		belongs to a group, expand it recursively.  Domain groups are
///		expanded via ADSI, while local groups are expanded via
///		NetLocalGroupGetMembers.
///	@param[in]	Command
///		The returned structure with a computed hash.
///	@param[in]	osPath
///		The mapped os path
///	@returns
///		Error
//-----------------------------------------------------------------
template <log::Lvl LvlT>
Error permissions::getPermissions(
    Entry &entry, Text &osPath, perms::PermissionInformation &permissions,
    store::filter::filesys::base::IBaseEndpoint<LvlT> &endpoint) noexcept {
    LOGT("Getting permissions for", entry);

    // Clear permissions in case we fail
    entry.permissionId.reset();
    entry.permissions.reset();

    auto rights = perms::getPermissions(osPath);

    if (!rights)
        return rights.ccode();
    else if (rights->empty())
        return {};

    if (endpoint.Type == "smb") {
        if (auto ccode =
                getEffectivePermissions(rights.value(), osPath, endpoint))
            return ccode;
    }
    // Save permissions, so we can check for changes next time we process this
    // item
    entry.permissions(_tj(_cast<perms::PermissionSet>(*rights)));

    // Add the permissions and get a set number
    auto permSetId = permissions.add(_mv(*rights));

    // Save them into the entry
    entry.permissionId(permSetId);
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Calculate effective owner and permissions for each file.
///		In Windows, users are identified via SID's.  For each SID
///		used, map the SID to the corresponding DOMAIN\USER. If the
///		SID cannot be mapped (e.g. it belongs to a deleted user or
///		the domain cannot be reached), don't include it. If the SID
///		belongs to a group, expand it recursively.  Domain groups are
///		expanded via ADSI, while local groups are expanded via
///		NetLocalGroupGetMembers.
///	@param[in]	Command
///		The returned structure with a computed hash.
///	@param[in]	osPath
///		The mapped os path
///	@returns
///		Error
//-----------------------------------------------------------------
template <log::Lvl LvlT>
Error permissions::getEffectivePermissions(
    perms::PermissionSet &entryPermission, Text &osPath,
    store::filter::filesys::base::IBaseEndpoint<LvlT> &endpoint) noexcept {
    auto appendServerName = [&](Text servername, Text path) {
        return Text(LongUncGen) + servername + path;
    };

    Text servername = ExtractAndRemoveServerName(osPath);
    Text parentPath = appendServerName(servername, osPath);
    Text filePath = osPath;
    size_t pos = filePath.size();

    Text ownerId = entryPermission.ownerId;

    // position to keep track of last '/'
    pos = filePath.find_last_of('\\', pos - 1);
    if (pos != Text::npos) {
        filePath.erase(pos + 1);  // Keep the '/' in the path
    }
    // get permissions for all parents and grandparents
    // In linux, if a user or a group doesn't have a execute permission on a
    // folder (traversal permission) then the group or the user has no access to
    // the file even if the user is the owner

    auto changeEntryValueTofalse = [&](perms::Rights &it) {
        it.canRead = false;
        it.canWrite = false;
        it.canExecute = false;
    };

    while (pos != 0 && pos != Text::npos) {
        parentPath = appendServerName(servername, filePath);

        // Get the owner and group of the parent directory
        struct perms::PermissionSet parentSt;

        {
            auto lock = endpoint.m_permissionLock.acquire();
            auto it = endpoint.m_folderPermissions.find(parentPath);
            if (it != endpoint.m_folderPermissions.end()) {
                parentSt = it->second;
            } else {
                auto rights = perms::getPermissions(parentPath);

                if (!rights)
                    return rights.ccode();
                else if (rights->empty())
                    return {};
                parentSt = rights.value();
                endpoint.m_folderPermissions[parentPath] = parentSt;
            }
        }

        bool executeOther = true;
        // check for "Other" execute permission on parent
        auto otherParentPerms =
            std::find_if(parentSt.perms.begin(), parentSt.perms.end(),
                         [](const perms::Permission val) {
                             return val.principalId == perms::WORLD_SID;
                         });
        if (otherParentPerms != parentSt.perms.end()) {
            executeOther = otherParentPerms->rights.canExecute.value_or(false);
        } else
            executeOther = false;
        // for each permission value on the entry, get effective permission
        auto it = entryPermission.perms.begin();
        while (it != entryPermission.perms.end()) {
            // all rights are already false, continue
            // if any of the right is not set, get the values
            if (!(it->rights.canExecute.value_or(true) ||
                  it->rights.canRead.value_or(true) ||
                  it->rights.canWrite.value_or(true))) {
                ++it;
                continue;
            }
            auto parentIt =
                std::find_if(parentSt.perms.begin(), parentSt.perms.end(),
                             [&it](const perms::Permission val) {
                                 return val.principalId == it->principalId;
                             });
            bool value = true;
            if (parentIt != parentSt.perms.end()) {
                value = parentIt->rights.canExecute.value_or(false);
            } else {
                if (!executeOther) value = false;
            }
            if (!value) {
                perms::Rights rights{
                    .canRead = false, .canWrite = false, .canExecute = false};

                Text principalId = it->principalId;
                it = entryPermission.perms.erase(it);
                entryPermission.perms.insert(perms::Permission{
                    .principalId = _ts(principalId), .rights = rights});
            } else {
                ++it;
            }
        }

        pos = filePath.find_last_of('\\', pos - 1);
        if (pos != Text::npos) {
            filePath.erase(pos + 1);  // Keep the '/' in the path
        }
    }

    return {};
}

}  // namespace engine::permission
