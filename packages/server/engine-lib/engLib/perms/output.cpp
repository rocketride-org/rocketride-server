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

#pragma once

namespace engine::perms {
//-------------------------------------------------------------------------
/// @details
///     Gather the permissions info
///    @param[in]    object
///        The object information about the object being opened
///    @returns
///        Error
//-------------------------------------------------------------------------
ErrorOr<Text> outputPermission(
    const Variant<CRef<PermissionSet>, CRef<GroupRecord>, CRef<UserRecord>>&
        arg) noexcept {
    MONITOR(status, "Writing permissions");

    Text line;

    // Based on the type -- pack it and output
    _visit(
        overloaded{
            [&](const CRef<PermissionSet> permSetRef) noexcept {
                auto& permSet = permSetRef.get();
                json::Value value;
                json::Value permValue;
                value["permissionId"] = permSet.id();
                value["ownerId"] = permSet.ownerId;
                value["permissions"] = json::Value(json::arrayValue);
                for (const auto& perm : permSet.perms) {
                    permValue["id"] = perm.principalId;
                    permValue["rights"] = _ts(perm.rights);
                    value["permissions"].append(permValue);
                }
                _tsbo(line,
                      {Format::NOFAIL | Format::APPEND | Format::DOUBLE_DELIMOK,
                       0, '*'},
                      'P', value.stringify(false), '\n');
            },
            [&](const CRef<GroupRecord> groupRef) noexcept {
                auto& group = groupRef.get();
                json::Value value;
                value["groupId"] = group.id;
                value["local"] = group.local ? true : false;
#if ROCKETRIDE_PLAT_WIN
                value["authority"] = _tr<Text>(group.authority);
                value["name"] = _tr<Text>(group.name);
#else
                value["authority"] = group.authority;
                value["name"] = group.name;
#endif
                value["memberIds"] = json::Value(json::arrayValue);
                for (auto groupId : group.memberIds) {
                    value["memberIds"].append(_tr<Text>(groupId));
                }

                _tsbo(line,
                      {Format::NOFAIL | Format::APPEND | Format::DOUBLE_DELIMOK,
                       0, '*'},
                      'G', value.stringify(false), '\n');
            },
            [&](const CRef<UserRecord> userRef) noexcept {
                auto& user = userRef.get();
                json::Value value;
                value["userId"] = user.id;
                value["local"] = user.local ? true : false;
#if ROCKETRIDE_PLAT_WIN
                value["authority"] = _tr<Text>(user.authority);
                value["name"] = _tr<Text>(user.name);
#else

                value["authority"] = user.authority;
                value["name"] = user.name;
#endif
                _tsbo(line,
                      {Format::NOFAIL | Format::APPEND | Format::DOUBLE_DELIMOK,
                       0, '*'},
                      'U', value.stringify(false), '\n');
            }},
        arg);

    ASSERTD(line);
    return line;
}

#if ROCKETRIDE_PLAT_WIN
// This method is called on win/perm.cpp.
// The reason it's only needed for Windows is because in Unix stat function
// already retrieves permissions data, while on Windows additional logic is
// required.
ErrorOr<PermissionSet> getPermissions(Text& osPath) noexcept {
    // Use the stack to store the security descriptor
    memory::SmallArena<uint8_t> arena;
    auto sdBuffer =
        fileSecurityDescriptor<memory::SmallAllocator<uint8_t>>(osPath, arena);
    if (!sdBuffer) {
        switch (sdBuffer.ccode().plat()) {
            case ERROR_ACCESS_DENIED:
            case ERROR_SHARING_VIOLATION:
                // GetFileSecurity requires read access to the file, which we
                // won't have for some system files. Fail silently in this case.
                // To reproduce, remove yourself as the owner of a file and set
                // all "Read" rows in the file ACL to "Deny".
                LOGX(ap::log::Lvl::JobPermissions,
                     "Unable to access file security info", sdBuffer.ccode());
                return PermissionSet{};

            default:
                return APERRX(ap::log::Lvl::JobPermissions, sdBuffer.ccode(),
                              "Failed to retrieve file security info");
        }
    }

    // Record permissions in a map based on references to the SID's in the
    // buffer
    SidRights rights;

    // Retrieve the owner and impute permissions
    if (auto sid = ownerSid(_reCast<PSECURITY_DESCRIPTOR>(sdBuffer->data()))) {
        rights.setOwner(sid);
    } else {
        MONERR(error, ::GetLastError(), "Failed to retrieve file owner",
               osPath);
    }

    // Walk the entries in the DACL and build a map of each SID's permissions
    if (auto ccode =
            rights.importDacl(_reCast<PSECURITY_DESCRIPTOR>(sdBuffer->data())))
        MONERR(error, ccode, "Failed to import file DACL");

    // Treat a file as failed if we weren't able to determine owner or DACL
    // rights
    if (rights.empty())
        return APERRX(ap::log::Lvl::JobPermissions, Ec::NoPermissions,
                      "No mappable rights found for file");

    return _cast<PermissionSet>(rights);
}
#endif

}  // namespace engine::perms
