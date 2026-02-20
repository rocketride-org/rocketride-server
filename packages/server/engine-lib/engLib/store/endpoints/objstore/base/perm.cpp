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
// Defines the permissions interface for the generic S3/object storage endpoint
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::baseObjectStore {
ErrorOr<engine::perms::Rights> IBaseInstance::getRights(
    const Aws::S3::Model::Permission& permission) noexcept {
    namespace AWSS3 = Aws::S3::Model;
    using namespace engine::perms;
    if (permission == AWSS3::Permission::NOT_SET)
        return APERR(Ec::NoPermissions, "Permissions are not set");

    Rights rights;
    if (permission == AWSS3::Permission::FULL_CONTROL) {
        rights.canRead = true;
        rights.canWrite = true;
    } else if (permission == AWSS3::Permission::READ) {
        rights.canRead = true;
    } else if (permission == AWSS3::Permission::WRITE) {
        rights.canWrite = true;
    }

    return rights;
}

Error IBaseInstance::mapId(TextView idStr,
                           std::unordered_set<Text>& mappedIds) noexcept {
    using namespace engine::perms;

    if (!idStr) return {};

    if (mappedIds.find(idStr) != mappedIds.end()) return {};

    // Insert the ID regardless of whether it can be mapped so we don't keep
    // trying to map the same bad ID
    mappedIds.insert(idStr);

    auto grantee = m_granteesById.find(idStr);
    if (grantee == m_granteesById.end()) {
        MONERR(warning, Ec::Warning, "Unable to map UID", idStr);
        return {};
    }

    const auto& granteeType = grantee->second.granteeType;
#if ROCKETRIDE_PLAT_WIN
    auto granteeName = _tr<Utf16>(grantee->second.granteeName);
#else
    auto granteeName = grantee->second.granteeName;
#endif

    switch (granteeType) {
        case Aws::S3::Model::Type::CanonicalUser:
        case Aws::S3::Model::Type::AmazonCustomerByEmail: {
            UserRecord userRecord{
                .id = idStr, .local = false, .name = granteeName};
            endpoint.permissionInfo.add(userRecord);
            break;
        }
        case Aws::S3::Model::Type::Group: {
            GroupRecord group{.id = idStr, .local = false, .name = granteeName};
            endpoint.permissionInfo.add(group);
            break;
        }
        default: {
            MONERR(error, Ec::InvalidParam, "Failed to parse ID", idStr);
            break;
        }
    }

    return {};
}

Error IBaseInstance::getPermissions(Entry& entry) noexcept {
    using namespace engine::perms;
    LOGT("Getting permissions for", entry);
    entry.permissionId.reset();

    if (auto ccode = ensureClient()) return ccode;

    Text entryPath;
    if (auto ccode = Url::toPath(entry.url(), entryPath)) {
        // Fail only one object
        entry.completionCode(ccode);
        return {};
    }

    // Make request to get object ACL
    auto request = endpoint.makeRequest<Aws::S3::Model::GetObjectAclRequest>(
        entryPath.toView());

    auto permissionsResp = m_streamClient->GetObjectAcl(request);
    if (!permissionsResp.IsSuccess()) {
        // Fail only one object
        auto ccode = APERR(
            Ec::Error, permissionsResp.GetError().GetExceptionName().c_str(),
            permissionsResp.GetError().GetMessage().c_str());
        entry.completionCode(ccode);
        return {};
    }

    const auto& owner = permissionsResp.GetResult().GetOwner();
    auto ownerId = owner.GetID();
    PermissionSet permSet;
    permSet.ownerId = ownerId;

    const auto& grants = permissionsResp.GetResult().GetGrants();
    for (const auto& grant : grants) {
        auto rights = getRights(grant.GetPermission());
        if (rights.hasCcode()) {
            // Fail only one object
            entry.completionCode(rights.ccode());
            return {};
        }
        // Get grantee and permission
        auto granteeType = grant.GetGrantee().GetType();
        Text granteeId;

        switch (granteeType) {
            case Aws::S3::Model::Type::CanonicalUser:
                granteeId = grant.GetGrantee().GetID();
                break;
            case Aws::S3::Model::Type::AmazonCustomerByEmail:
                granteeId = grant.GetGrantee().GetEmailAddress();
                break;
            case Aws::S3::Model::Type::Group:
                granteeId = grant.GetGrantee().GetURI();
                break;
            default:
                entry.completionCode(
                    APERRT(Ec::NoPermissions, "Wrong grantee type for file"));
                return {};
        }

        // Amazon removes Grantee's Display Name -> user ID as display name
        auto granteeName = granteeId;

        _using(auto lock = m_lock.acquire()) {
            m_granteesById.emplace(
                granteeId, ObjectGrants{.granteeName = _mv(granteeName),
                                        .granteeType = _mv(granteeType)});
        }

        permSet.perms.insert(Permission{.principalId = _mv(granteeId),
                                        .rights = _mv(rights.value())});
    }

    // Treat a file as failed if we weren't able to determine owner or rights
    if (permSet.empty()) {
        entry.completionCode(
            APERRT(Ec::NoPermissions, "No mappable rights found for file"));
        return {};
    }

    // Add the permissions and get a set number
    auto permSetId = endpoint.permissionInfo.add(_mv(permSet));

    // Save them into the entry
    entry.permissionId(permSetId);

    return {};
}

ErrorOr<std::list<Text>> IBaseInstance::outputPermissions() noexcept {
    if (!endpoint.permissionInfo.size()) return {};

    const auto permsList = endpoint.permissionInfo.build();
    MONITOR(status, "Preparing principals");
    std::unordered_set<Text> mappedIds;

    // map all users/groups
    // continue processing even if `mapId` returns an error
    for (const auto& permSet : permsList) {
        Error ccode = mapId(permSet.ownerId, mappedIds);
        for (const auto& perm : permSet.perms)
            ccode = mapId(perm.principalId, mappedIds);
    }

    return endpoint.outputPermissions();
}
}  // namespace engine::store::filter::baseObjectStore
