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

_const SID_IDENTIFIER_AUTHORITY AzureAdSidAuthority = {0, 0, 0, 0, 0, 12};

inline ErrorOr<Sid> getSid(const wchar_t* username) noexcept {
    ASSERTD(username);

    uint8_t sid[SECURITY_MAX_SID_SIZE];
    auto sidLength = _cast<DWORD>(std::size(sid));
    wchar_t domain[256];
    auto domainLength = _cast<DWORD>(std::size(domain));
    SID_NAME_USE sidUse;
    if (!::LookupAccountNameW(nullptr, username, sid, &sidLength, domain,
                              &domainLength, &sidUse))
        return APERRL(Permissions, ::GetLastError());

    return Sid::fromPtr(sid);
}

// Get this machine's SID
inline ErrorOr<Sid> getMachineSid() noexcept {
    wchar_t machineName[MAX_COMPUTERNAME_LENGTH + 1];
    auto machineNameLength = _cast<DWORD>(std::size(machineName));
    if (!::GetComputerNameExW(ComputerNameNetBIOS, machineName,
                              &machineNameLength))
        return APERRL(Permissions, ::GetLastError());

    return getSid(machineName);
}

// Get the SID of the current user
inline ErrorOr<Sid> getCurrentUserSid() noexcept {
    wil::unique_handle hProcessToken;
    if (!::OpenProcessToken(::GetCurrentProcess(), TOKEN_QUERY, &hProcessToken))
        return APERRL(Permissions, ::GetLastError());

    DWORD length = 0;
    ::GetTokenInformation(hProcessToken.get(), TokenUser, nullptr, 0, &length);

    auto userInfo = reinterpret_cast<TOKEN_USER*>(malloc(length));
    if (!userInfo) return APERRL(Permissions, Ec::OutOfMemory);
    util::Guard userInfoCleanup([=]() { free(userInfo); });

    if (!::GetTokenInformation(hProcessToken.get(), TokenUser, userInfo, length,
                               &length))
        return APERRL(Permissions, ::GetLastError());

    return Sid::fromPtr(userInfo->User.Sid);
}

// Test whether a user or group SID is local (vs. domain)
inline bool isLocalSid(const Sid& sid) noexcept {
    if (auto domainSid = sid.domainSid()) return machineSid() == domainSid;
    return true;
}

inline bool compareSidAuthorities(PSID_IDENTIFIER_AUTHORITY lhs,
                                  PSID_IDENTIFIER_AUTHORITY rhs) noexcept {
    return std::memcmp(lhs, rhs, sizeof(SID_IDENTIFIER_AUTHORITY)) == 0;
}

// Is the SID_NAME_USE from LookupAccountName a group?
inline bool isGroupSidUse(SID_NAME_USE sidUse) noexcept {
    // Well-known SID's can correspond to "security principals" that are neither
    // groups nor users, but we'll treat them as groups
    switch (sidUse) {
        case SidTypeGroup:
        case SidTypeAlias:
        case SidTypeWellKnownGroup:
            return true;

        default:
            return false;
    }
}

// Gets a user or group's effective rights from an file's DACL
// WARNING: Slow and unreliable
inline ErrorOr<ACCESS_MASK> getSidEffectiveRights(const Sid& sid,
                                                  PACL dacl) noexcept {
    ASSERT(sid && dacl);

    TRUSTEEW trustee{.pMultipleTrustee = nullptr,
                     .MultipleTrusteeOperation = NO_MULTIPLE_TRUSTEE,
                     .TrusteeForm = TRUSTEE_IS_SID,
                     .TrusteeType = TRUSTEE_IS_UNKNOWN,
                     .ptstrName = sid.ptr<wchar_t>()};
    ACCESS_MASK effectiveRights;
    if (auto error =
            ::GetEffectiveRightsFromAclW(dacl, &trustee, &effectiveRights))
        return APERRL(Permissions, error,
                      "Unable to calculate effective rights", sid);
    return effectiveRights;
}

struct WindowsIdentity {
    enum class Type {
        typeLocal,
        typeDomain,
        typeAzureAD,
    };

    Sid sid;
    Utf16 domain;
    Utf16 username;
    Type type;
    bool isGroup;

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        return string::formatBuffer(buff, "{}\\{}", domain, username);
    }
};

inline WindowsIdentity::Type getIdentityType(const Sid& sid) noexcept {
    if (isLocalSid(sid)) {
        if (compareSidAuthorities(
                ::GetSidIdentifierAuthority(sid.ptr()),
                _constCast<PSID_IDENTIFIER_AUTHORITY>(&AzureAdSidAuthority)))
            return WindowsIdentity::Type::typeAzureAD;
        else
            return WindowsIdentity::Type::typeLocal;
    } else
        return WindowsIdentity::Type::typeDomain;
}

// Retrieve the Windows user or group for a given SID
inline ErrorOr<WindowsIdentity> sidToWindowsIdentity(
    const Sid& sid, const Text& systemName) noexcept {
    // Lookup the SID
    ASSERT(sid);
    wchar_t username[1_kb];
    auto usernameLength = _cast<DWORD>(std::size(username));
    wchar_t domain[1_kb];
    auto domainLength = _cast<DWORD>(std::size(domain));
    SID_NAME_USE sidUse;

    if (!::LookupAccountSidW(nullptr, sid.ptr(), username, &usernameLength,
                             domain, &domainLength, &sidUse)) {
        if (!systemName.empty()) {
            Utf16 systemNameU16 = systemName;
            if (!::LookupAccountSidW(systemNameU16.c_str(), sid.ptr(), username,
                                     &usernameLength, domain, &domainLength,
                                     &sidUse)) {
                return APERRL(Permissions, ::GetLastError(),
                              "Unable to resolve SID to Windows identity");
            }
        } else {
            return APERRL(Permissions, ::GetLastError(),
                          "Unable to resolve SID to Windows identity");
        }
    }

    return WindowsIdentity{
        sid,
        Utf16(domain, domainLength),
        Utf16(username, usernameLength),
        getIdentityType(sid),
        isGroupSidUse(sidUse),
    };
}

inline Sid ownerSid(PSECURITY_DESCRIPTOR sd) noexcept {
    PSID ownerSid = nullptr;
    BOOL ignored;
    if (::GetSecurityDescriptorOwner(sd, &ownerSid, &ignored) && ownerSid)
        return Sid::fromPtr(ownerSid);
    return {};
}

inline Sid ownerGid(Text& parentPath) noexcept {
    PSID ownerGid = nullptr;
    PSECURITY_DESCRIPTOR pSecurityDescriptor;
    auto result = ::GetNamedSecurityInfo(
        parentPath, SE_FILE_OBJECT,
        GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, NULL, &ownerGid,
        NULL, NULL, &pSecurityDescriptor);

    PACL dacl = nullptr;
    BOOL ignored;
    if (!::GetSecurityDescriptorDacl(pSecurityDescriptor, &ignored, &dacl,
                                     &ignored))
        return {};

    // If the function succeeds but no DCAL is returned, the object has no
    // permissions set
    if (!dacl) return {};

    for (decltype(dacl->AceCount) i = 0; i < dacl->AceCount; ++i) {
        PACE_HEADER header;
        if (!::GetAce(dacl, i, _reCast<LPVOID*>(&header))) return {};

        switch (header->AceType) {
            case ACCESS_ALLOWED_ACE_TYPE: {
                break;
            }
            case ACCESS_DENIED_ACE_TYPE: {
                // ACCESS_DENIED entries trump everything else
                break;
            }
            case ACCESS_ALLOWED_CALLBACK_ACE_TYPE:
            case ACCESS_DENIED_CALLBACK_ACE_TYPE:
                // TODO: These are Dynamic Access Control records that must be
                // evaluated by calling AuthzAccessCheck
                break;
        }
    }
    if (result || ownerGid) return Sid::fromPtr(ownerGid);
    return {};
}

template <typename AllocT = std::allocator<uint8_t>>
ErrorOr<memory::Data<uint8_t, AllocT>> fileSecurityDescriptor(
    const file::Path& path, const AllocT& allocator = {}) noexcept {
    // Allocate an initial buffer of 512 bytes (SECURITY_DESCRIPTOR_MIN_LENGTH
    // is 40 and is usually too small)
    memory::Data<uint8_t, AllocT> sdBuffer(allocator);
    sdBuffer.resize(512);

    _const SECURITY_INFORMATION si = OWNER_SECURITY_INFORMATION |
                                     GROUP_SECURITY_INFORMATION |
                                     DACL_SECURITY_INFORMATION;
    DWORD lengthNeeded = {};
    if (::GetFileSecurityW(path.plat(), si, sdBuffer.data(),
                           sdBuffer.sizeAs<DWORD>(), &lengthNeeded)) {
        // Don't resize the sdBuffer to lengthNeeded, which will be 0 if the
        // buffer was big enough
        return sdBuffer;
    }

    // If the default allocator size was too small to store the security
    // descriptor, reallocate and try again
    if (::GetLastError() == ERROR_INSUFFICIENT_BUFFER) {
        sdBuffer.resize(lengthNeeded, false);
        if (::GetFileSecurityW(path.plat(), si, sdBuffer.data(),
                               sdBuffer.sizeAs<DWORD>(), &lengthNeeded))
            return sdBuffer;
    }

    return APERRL(Permissions, ::GetLastError(), "GetFileSecurity failed",
                  path);
}

template <typename Callback>
Error expandLocalGroup(const WindowsIdentity& group,
                       Callback&& callback) noexcept {
    if (!group.isGroup || (group.type != WindowsIdentity::Type::typeLocal &&
                           group.type != WindowsIdentity::Type::typeDomain))
        return APERRL(Permissions, Ec::InvalidParam, "Not a local group",
                      group);

    LOG(Permissions, "Expanding local group:", group);
    PLOCALGROUP_MEMBERS_INFO_0 members;
    DWORD entriesRead;
    DWORD totalEntries;
    DWORD_PTR resumeHandle = {};
    NET_API_STATUS status = ERROR_MORE_DATA;
    while (status == ERROR_MORE_DATA) {
        // Query the group members (may contain either domain or local users)
        bool useDomain = !group.sid.builtinSecurityGroup();
        status = ::NetLocalGroupGetMembers(
            useDomain ? group.domain.c_str() : nullptr, group.username, 0,
            _reCast<LPBYTE*>(&members), MAX_PREFERRED_LENGTH, &entriesRead,
            &totalEntries, &resumeHandle);
        switch (status) {
            case NERR_Success:
            case ERROR_MORE_DATA:
                break;

            case ERROR_ACCESS_DENIED:
                MONERR(warning, status,
                       string::format("Could not get members of group '{}' on "
                                      "local server '{}'",
                                      group.username, group.domain));
                return {};

            case NERR_GroupNotFound:
                return APERRL(Permissions, Ec::NotFound,
                              "Local group not found", group);

            default:
                return APERRL(Permissions, status,
                              "Failed to expand local group", group);
        }
        util::Guard membersCleanup([=]() { ::NetApiBufferFree(members); });

        for (decltype(entriesRead) i = 0; i < entriesRead; ++i) {
            if (!perms::Sid::supported(members[i].lgrmi0_sid)) continue;
            const auto memberSid = perms::Sid::fromPtr(members[i].lgrmi0_sid);
            if (auto ccode = callback(memberSid);
                ccode && ccode != Ec::NotFound)
                return ccode;
        }
    }
    return {};
}

// The "Domain Users" group is a computed group with no actual members and must
// be expanded differently [APPLAT-805]
template <typename Callback>
Error expandDomainUsersGroup(const Sid& domainSid,
                             Callback&& callback) noexcept {
    if (!domainSid)
        return APERRL(Permissions, Ec::InvalidParam, "Domain SID is null");

    // ADSI requires COM; COM must be initialized (and uninitialized) from the
    // worker thread ComInit::init will initialize COM once and store the result
    // in thread-local storage
    if (auto ccode = plat::ComInit::init()) return ccode;

    // Open the domain object via its SID to we can get the domain's
    // distinguished name for the user search
    LOG(Permissions, "Expanding Domain Users computed group");
    Utf16 domainDn;
    try {
        perms::adsi::DirectoryObject domain{domainSid};
        domainDn = domain.dn();
        if (!domainDn)
            return APERRL(Permissions, Ec::Unexpected,
                          "Unable to determine domain's distinguished name",
                          domainSid);
    } catch (const Error& ccode) {
        return APERRL(Permissions, ccode, "Failed to open domain object",
                      domainSid);
    }

    // Use a directory search to enumerate all users in the domain
    LOG(Permissions, "Querying all users in the domain:", domainDn);
    try {
        perms::adsi::DirectorySearch search{_fmt("LDAP://{}", domainDn),
                                            "(&(objectCategory=User))"};
        while (auto userSid = search.next()) {
            if (auto ccode = callback(*userSid); ccode && ccode != Ec::NotFound)
                return ccode;
        }
        return {};
    } catch (const Error& ccode) {
        return APERRL(Permissions, ccode, "Failed to enumerate domain users",
                      domainSid);
    }
}

template <typename Callback>
Error expandDomainGroup(const WindowsIdentity& group,
                        Callback&& callback) noexcept {
    if (!group.isGroup || group.type != WindowsIdentity::Type::typeDomain)
        return APERRL(Permissions, Ec::InvalidParam, "Not a domain group",
                      group);

    // The "Domain Users" group is a computed group with no actual members and
    // must be expanded differently [APPLAT-805]
    if (group.sid.relativeId() == DOMAIN_GROUP_RID_USERS)
        return expandDomainUsersGroup(group.sid.domainSid(), _mv(callback));

    // ADSI requires COM; COM must be initialized (and uninitialized) from the
    // worker thread ComInit::init will initialize COM once and store the result
    // in thread-local storage
    if (auto ccode = plat::ComInit::init()) return ccode;

    // Expand the members into a temporary vector so that we aren't possibly
    // recursing into ADSI in the callback, which may open a lot of objects on
    // the stack
    LOG(Permissions, "Expanding domain group:", group);
    std::vector<Sid> memberSids;
    try {
        perms::adsi::DirectoryObject groupObject(group.sid);
        perms::adsi::DnStringArray memberDns = groupObject.memberDns();
        for (size_t i = 0; i < memberDns.size(); ++i) {
            // Note that we could use ADSI to retrieve the details needed to map
            // the SID instead, but this is simpler
            auto memberDn = memberDns.value(i);
            try {
                perms::adsi::DirectoryObject member(memberDn);
                if (auto memberSid = member.sid())
                    memberSids.emplace_back(_mv(memberSid));
            } catch (const Error& ccode) {
                // Log the member that failed
                LOG(Permissions, "Failed to map group member", ccode, memberDn);
            }
        }
    } catch (const Error& ccode) {
        return APERRL(Permissions, ccode, "Failed to expand domain group",
                      group);
    }

    for (auto& memberSid : memberSids) {
        if (auto ccode = callback(memberSid); ccode && ccode != Ec::NotFound)
            return ccode;
    }
    return {};
}

template <typename Callback>
Error expandGroup(const WindowsIdentity& group, Callback&& callback) noexcept {
    switch (group.type) {
        case perms::WindowsIdentity::Type::typeLocal:
            return expandLocalGroup(group, _mv(callback));

        case perms::WindowsIdentity::Type::typeDomain: {
            auto eDomain = expandDomainGroup(group, _mv(callback));
            if (eDomain) {
                auto eLocal = expandLocalGroup(group, _mv(callback));
                if (!eLocal) return eLocal;
            }
            return eDomain;
        }

        default:
            return APERR(Ec::Unexpected, "Unexpected group type", group);
    }
}

}  // namespace engine::perms
