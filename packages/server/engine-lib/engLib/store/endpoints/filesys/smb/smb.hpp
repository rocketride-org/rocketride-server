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

//-----------------------------------------------------------------------------
//
//	Declares the interface for nodes
//
//-----------------------------------------------------------------------------
#pragma once

//-----------------------------------------------------------------------------
// Include the interfaces we support
//-----------------------------------------------------------------------------
#include "../base/base.hpp"

namespace engine::store::filter::filesys::smb {
using namespace engine::store::filter::filesys::base;

class IFilterEndpoint;
class IFilterGlobal;
class IFilterInstance;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceSmb;

//-------------------------------------------------------------------------
/// @details
///		Declare our factory info
//-------------------------------------------------------------------------
_const auto Type = IBaseEndpoint<Level>::Type;

//-------------------------------------------------------------------------
///	@details
///		This class defines the node interface to the file system
//-------------------------------------------------------------------------
class IFilterGlobal : public IBaseGlobal<Level> {
public:
    using Config = IServiceConfig;
    using Parent = IBaseGlobal<Level>;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		Allow the filter instance to see our private data. We can
    ///		either make it public, or limit the scope to IFilterInstance
    //-----------------------------------------------------------------
    friend IFilterInstance;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterGlobal, Parent>(Type);
};

//-------------------------------------------------------------------------
///	@details
///		Filter class for handling file/smb I/O
//-------------------------------------------------------------------------
class IFilterInstance : public IBaseInstance<Level> {
public:
    using Config = IServiceConfig;
    using Parent = IBaseInstance<Level>;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterInstance, Parent>(Type);

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IFilterInstance(const FactoryArgs &args) noexcept : Parent(args) {
        auto &serviceConfig = endpoint->config.serviceConfig;

        // Get the endpoint protocol type
        auto type = IServiceEndpoint::getLogicalType(serviceConfig);
        do {
            if (type.hasCcode()) {
                MONERR(warning, type.ccode(),
                       "Failed to get service configuration, skipping setting "
                       "system name");
                break;
            }

            if (*type == "smb")
                permissions.setSystemName(
                    endpoint->config.shareConfig.getSystemName());

        } while (false);
    }

    virtual ~IFilterInstance() {}
#ifdef ROCKETRIDE_PLAT_UNX
    //-----------------------------------------------------------------
    /// @details
    ///		Mapid
    /// @param[in]  idStr
    ///     The unique key idenifing the UUID.
    /// @param[in]  mappedIds
    ///     Already mapped ids
    /// @returns
    ///     mapped Id
    //-----------------------------------------------------------------
    Error mapId(TextView idStr, std::unordered_set<Text> &mappedIds) noexcept {
        using namespace perms;
        using namespace engine::smb::perms;

        if (!idStr) return {};

        if (mappedIds.find(idStr) != mappedIds.end()) return {};

        // Insert the ID regardless of whether it can be mapped so we don't keep
        // trying to map the same bad ID
        mappedIds.insert(idStr);

        auto username = m_endpoint.m_names.find(idStr);
        if (username == m_endpoint.m_names.end()) {
            MONERR(warning, Ec::Warning, "Unable to map UID", idStr);
            return {};
        }

        if (username->second.type == idPermissionType::USER) {
            UserRecord userRecord{.id = idStr,
                                  .local = false,
                                  .authority = username->second.authority,
                                  .name = username->second.name};
            m_endpoint.permissionInfo.add(userRecord);
        } else {
            GroupRecord group{.id = idStr,
                              .local = false,
                              .authority = username->second.authority,
                              .name = username->second.name};
            m_endpoint.permissionInfo.add(group);
        }

        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		get permissions for the path
    /// @param[in]  serverName
    ///     serverName.
    /// @param[in]  shareName
    ///     Entry shareName
    /// @param[in]  filePath
    ///     Entry filePath
    /// @returns
    ///     Permissions for the filePath
    //-----------------------------------------------------------------
    ErrorOr<perms::PermissionSet> getPermissions(Text serverName,
                                                 Text shareName,
                                                 Text filePath) {
        using namespace engine::smb::perms;
        PermissionSet permSet;
        auto ccode = ap::file::smb::client().getAcl(
            m_endpoint.m_names, serverName, shareName, filePath);
        if (ccode.hasCcode()) {
            return MONERR(warning, Ec::Warning, "Could not get permissions",
                          filePath, ccode.ccode());
        }

        struct sec_descriptor sd = ccode.value();
        permSet.ownerId = sd.ownerId;
        auto ownerDcl = sd.findId(sd.ownerId);
        if (auto rights = makeRights_smb(ownerDcl.mask, ownerDcl.type)) {
            permSet.perms.insert(
                Permission{.principalId = sd.ownerId, .rights = rights});
        }

        // add permissions for dcls
        for (auto &d : sd.dcls) {
            if (auto rights = makeRights_smb(d.mask, d.type)) {
                auto value =
                    Permission{.principalId = d.ownerId, .rights = rights};

                int foundRights = false;
                auto permValue = permSet.perms.begin();

                // check if the same Id permissions values were added
                while (permValue != permSet.perms.end()) {
                    if (permValue->principalId == value.principalId) {
                        foundRights = true;
                        break;
                    }
                    permValue++;
                }

                // update the permissions if added
                if (foundRights) {
                    Rights rightsValue = permValue->rights;
                    if (!rightsValue.canRead.has_value())
                        rightsValue.canRead = value.rights.canRead;
                    if (!rightsValue.canWrite.has_value())
                        rightsValue.canWrite = value.rights.canWrite;
                    if (!rightsValue.canExecute.has_value())
                        rightsValue.canExecute = value.rights.canExecute;

                    Text principalId = permValue->principalId;
                    permValue = permSet.perms.erase(permValue);
                    permSet.perms.insert(
                        perms::Permission{.principalId = _ts(principalId),
                                          .rights = rightsValue});
                } else {
                    permSet.perms.insert(value);
                }
            }
        }
        return permSet;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		get effective permissions for the entry
    /// @param[in]  entry
    ///     The Entry.
    /// @param[in]  permSet
    ///     Entry permissions
    /// @returns
    ///     effective permissions
    //-----------------------------------------------------------------
    virtual Error getEffectivePermissions(
        Entry &entry, perms::PermissionSet &permSet) noexcept {
        using namespace engine::smb::perms;
        // Get the path from entry
        Path path = entry.path();

        // Check path validity, in case if is not valid - just ignore it
        // It is permissions task: APP may send invalid path
        if (!path.valid()) {
            return {};
        }

        // file path should be in \\ format
        Text filePath(path.subpth(2));
        filePath.replace('/', '\\');
        Text servername(path.at(0));
        Text sharename(path.at(1));
        Text parentPath = filePath;
        size_t pos = filePath.size();

        // Find the last '\\' in the file path
        pos = filePath.find_last_of('\\', pos - 1);
        if (pos != Text::npos) {
            filePath.erase(pos + 1);  // Keep the '\\' in the path
        }
        // Lambda function to change rights values to false
        auto changeValueToFalse = [](Rights &right) {
            right.canRead = false;
            right.canWrite = false;
            right.canExecute = false;
        };

        // Lambda function to find permission with Id
        auto findPerm = [&](std::set<Permission> perms, Text id, bool &found) {
            for (auto it : perms) {
                if (id == it.principalId) {
                    found = true;
                    return it;
                }
            }
            found = false;
            return Permission();
        };

        // get permissions for all parents and grandparents
        // In linux, if a user or a group doesn't have a execute permission on a
        // folder (traversal permission) then the group or the user has no
        // access to the file even if the user is the owner
        while (pos != 0 && pos != Text::npos) {
            // Store parent path
            parentPath = filePath;
            perms::PermissionSet parentPermSet;
            {
                auto lock = m_endpoint.m_parentPermissionLock.acquire();
                // Check if permissions for parent path are cached
                auto it = m_endpoint.m_parentPermissions.find(parentPath);

                if (it != m_endpoint.m_parentPermissions.end()) {
                    parentPermSet = it->second;
                } else {
                    lock.unlock();
                    // if path already invalid -> break the loop
                    if (!Path(parentPath).valid()) {
                        break;
                    }

                    // Retrieve permissions from server if not cached
                    auto ccode =
                        getPermissions(servername, sharename, parentPath);
                    if (ccode.hasCcode()) {
                        return MONERR(warning, Ec::Warning,
                                      "Could not get permissions");
                    }
                    parentPermSet = ccode.value();

                    // cache permissions
                    lock.lock();
                    m_endpoint.m_parentPermissions.emplace(parentPath,
                                                           parentPermSet);
                }
            }

            bool executeOther = true;
            // check for "Other" execute permission on parent
            auto otherParentPerms = std::find_if(
                parentPermSet.perms.begin(), parentPermSet.perms.end(),
                [](const perms::Permission val) {
                    return val.principalId == perms::WORLD_SID;
                });
            if (otherParentPerms != parentPermSet.perms.end()) {
                executeOther =
                    otherParentPerms->rights.canExecute.value_or(false);
            } else
                executeOther = false;

            // Update entry permissions based on parent and other permissions
            auto entryPermValue = permSet.perms.begin();
            while (entryPermValue != permSet.perms.end()) {
                // all rights are already false, continue
                // if any of the right is not set, get the values
                if (!(entryPermValue->rights.canExecute.value_or(true) ||
                      entryPermValue->rights.canRead.value_or(true) ||
                      entryPermValue->rights.canWrite.value_or(true))) {
                    ++entryPermValue;
                    continue;
                }
                Text id = entryPermValue->principalId;

                bool changeValue = false;
                if (perms::matchesWellKnownSID(entryPermValue->principalId)) {
                    if (id == perms::WORLD_SID && !executeOther) {
                        changeValue = true;
                    }
                } else {
                    bool found = false;
                    auto perm = findPerm(parentPermSet.perms, id, found);

                    if (found) {
                        if (!perm.rights.canExecute.value_or(false)) {
                            changeValue = true;
                        }
                    } else {
                        if (!executeOther) {
                            changeValue = true;
                        }
                    }
                }

                if (changeValue) {
                    perms::Rights rights{.canRead = false,
                                         .canWrite = false,
                                         .canExecute = false};

                    Text principalId = entryPermValue->principalId;
                    // erase the permission and add a new permissions
                    entryPermValue = permSet.perms.erase(entryPermValue);

                    // add new permissions
                    permSet.perms.insert(perms::Permission{
                        .principalId = _ts(principalId), .rights = rights});
                } else
                    entryPermValue++;
            }

            // Move to the next parent path
            pos = filePath.find_last_of('\\', pos - 1);
            if (pos != Text::npos) {
                filePath.erase(pos + 1);  // Keep the '/' in the path
            }
        }

        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		get permissions for the entry
    /// @param[in]  entry
    ///     The Entry.
    /// @param[in]  permSet
    ///     Entry permissions
    /// @returns
    ///     Permissions
    //-----------------------------------------------------------------
    virtual Error getPermissions(Entry &entry) noexcept override {
        using namespace engine::smb::perms;

        LOGT("Getting permissions for", entry);

        // Clear entry fields in case we fail
        entry.permissionId.reset();
        Path path = entry.path();

        // Check path validity, in case if is not valid - just ignore it
        // It is permissions task: APP may send invalid path
        if (!path.valid()) {
            return {};
        }

        // file path should be in \\ format
        Text filePath(path.subpth(2));
        filePath.replace('/', '\\');
        Text servername(path.at(0));
        Text sharename(path.at(1));
        PermissionSet permSet;
        auto ccode = getPermissions(servername, sharename, filePath);
        if (ccode.hasCcode()) {
            return MONERR(warning, Ec::Warning, "Could not get permissions",
                          filePath, ccode.ccode());
        }

        permSet = ccode.value();

        // Treat a file as failed if we weren't able to determine owner or
        // rights
        if (permSet.empty()) {
            APERRT(Ec::NoPermissions, "No mappable rights found for file",
                   entry);
            return {};
        }

        // get the effective permissions
        if (auto permccode = getEffectivePermissions(entry, permSet))
            MONERR(warning, Ec::Warning, "Could not get effective permissions");

        // Add the permissions and get a set number
        auto permSetId = m_endpoint.permissionInfo.add(_mv(permSet));

        // Save them into the entry
        entry.permissionId(permSetId);
        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Output the permissions
    /// @returns
    ///     List of the permissions
    //-----------------------------------------------------------------
    virtual ErrorOr<std::list<Text>> outputPermissions() noexcept override {
        const auto permsList = m_endpoint.permissionInfo.build();
        MONITOR(status, "Preparing principals");
        std::unordered_set<Text> mappedIds;

        // map all users/groups
        // continue processing even if `mapId` returns an error
        for (const auto &permSet : permsList) {
            Error ccode = mapId(permSet.ownerId, mappedIds);
            for (const auto &perm : permSet.perms)
                ccode = mapId(perm.principalId, mappedIds);
        }

        return endpoint->outputPermissions();
    }

#endif
};

//-------------------------------------------------------------------------
/// @details
///		Define the endpoint
//-------------------------------------------------------------------------
class IFilterEndpoint : public IBaseEndpoint<Level> {
public:
    using Config = IServiceConfig;
    using Parent = IBaseEndpoint<Level>;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		Allow the filter instance to see our private data. We can
    ///		either make it public, or limit the scope to IFilterInstance
    //-----------------------------------------------------------------
    friend IFilterInstance;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterEndpoint, Parent>(Type);

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginEndpoint(OPEN_MODE openMode) noexcept override;
    virtual Error getConfigSubKey(Text &key) noexcept override;
    virtual Error validateConfig(bool syntaxOnly) noexcept override;

private:
    virtual Error validatePaths(json::Value &service, TextView sectionName,
                                bool checkEmpty) noexcept;

private:
    //-----------------------------------------------------------------
    /// @details
    ///	    Mounted context, gets mounted on setting up of the endpoint
    //-----------------------------------------------------------------
    std::vector<file::smb::MountCtx> m_mounts;
};
}  // namespace engine::store::filter::filesys::smb
