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

namespace engine::store::filter::outlook {
//-------------------------------------------------------------------------
/// @details
///		Checks if the object has changed.
///     NOTE: Emails can change, the modify time will change.
///	@param[inout] object
///		The entry to update
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::getPermissions(Entry &object) noexcept {
    LOGT("Checking for Permissions Outlook object '{}'", object.fileName());
    // Clear entry fields in case we fail
    object.permissionId.reset();
    using namespace perms;
    if (auto ccode = getClient()) {
        object.completionCode(ccode);
        return {};
    }
    auto fullPath = object.url().path();
    // path is /username/path

    Text userName = fullPath.at(USERNAME_POS);
    auto ccodeUserId = m_msEmailNode->getUserId(userName);
    if (ccodeUserId.hasCcode()) return ccodeUserId.ccode();

    Text userId = ccodeUserId.value();

    // user is the owner
    PermissionSet permSet;
    Rights rights;
    rights.canRead = true;
    rights.canWrite = true;
    permSet.ownerId = userId;
    permSet.perms.insert(Permission{.principalId = userId, .rights = rights});

    // Treat a file as failed if we weren't able to determine owner or rights
    if (permSet.empty())
        return APERRT(Ec::NoPermissions, "No mappable rights found for file",
                      object);

    // Add the permissions and get a set number
    auto permSetId = endpoint.permissionInfo.add(_mv(permSet));

    // Save them into the entry
    object.permissionId(permSetId);
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Map an Id and create an entry for it in the global data if needed
///	@param[in]	id
///		The Id to map
/// @param[in|out]	mappedIds
///		The returned structure with a computed hash.
///	@returns
///		Error
//-----------------------------------------------------------------
Error IFilterInstance::mapId(TextView id,
                             std::unordered_set<Text> &mappedIds) noexcept {
    using namespace perms;
    using namespace string::icu;
    if (!id) return {};

    if (mappedIds.find(id) != mappedIds.end()) return {};

    // Insert the ID regardless of whether it can be mapped so we don't keep
    // trying to map the same bad ID
    mappedIds.insert(id);

    auto userMail = m_msEmailNode->getUserMailAddress(id);
    if (!userMail) return userMail.ccode();

#if ROCKETRIDE_PLAT_WIN
    auto name = _tr<Utf16>(Text(userMail.value()));
#else
    auto name = userMail.value();
#endif
    UserRecord userRecord{
        .id = id,
        .local = false,
        .authority =
            _fmt("microsoft:{}", m_msEmailNode->m_msConfig->m_tenantId),
        .name = name};

    endpoint.permissionInfo.add(userRecord);
    return {};
}

ErrorOr<std::list<Text>> IFilterInstance::outputPermissions() noexcept {
    if (!endpoint.permissionInfo.size()) return {};

    const auto permsList = endpoint.permissionInfo.build();
    MONITOR(status, "Preparing principals");
    std::unordered_set<Text> mappedIds;

    // map all trustees
    for (const auto &permSet : permsList) {
        Error ccode = mapId(permSet.ownerId, mappedIds);
        for (const auto &perm : permSet.perms)
            ccode = mapId(perm.principalId, mappedIds);
    }

    return endpoint.outputPermissions();
}
}  // namespace engine::store::filter::outlook
