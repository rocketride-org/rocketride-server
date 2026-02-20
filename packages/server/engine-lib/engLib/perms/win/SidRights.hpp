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

#pragma once

namespace engine::perms {

class SidRights : public std::map<Sid, Rights> {
public:
    using Parent = std::map<Sid, Rights>;

    void applyAllow(const Sid &sid, DWORD mask) noexcept {
        ASSERT(sid);

        auto &right = (*this)[sid];
        // These are the only three rights we care about
        if (!(mask & (FILE_READ_DATA | FILE_WRITE_DATA | FILE_TRAVERSE))) {
            right.canWrite = false;
            right.canRead = false;
            right.canExecute = false;
        }
        // In windows, the order of premission matters. Also matters if a
        // permission was not present before For eg, UserA has the following
        // permissions in order 1: Write Deny 2: Read Allowed 3: Write Allowed
        // 4: Read Deny
        // the effective permission would be +r-w
        if (!right.canRead.has_value() && (mask & FILE_READ_DATA))
            right.canRead = true;
        if (!right.canWrite.has_value() && (mask & FILE_WRITE_DATA))
            right.canWrite = true;
        if (!right.canExecute.has_value() && (mask & FILE_TRAVERSE))
            right.canExecute = true;
    }

    void applyDeny(const Sid &sid, DWORD mask) noexcept {
        ASSERT(sid);

        auto &right = (*this)[sid];

        // These are the only three rights we care about
        if (!(mask & (FILE_READ_DATA | FILE_WRITE_DATA | FILE_TRAVERSE))) {
            right.canWrite = false;
            right.canRead = false;
            right.canExecute = false;
        }

        // In windows, the order of premission matters. Also matters if a
        // permission was not present before For eg, UserA has the following
        // permissions in order 1: Write Deny 2: Read Allowed 3: Write Allowed
        // 4: Read Deny
        // the effective permission would be +r-w
        if (!right.canRead.has_value() && (mask & FILE_READ_DATA))
            right.canRead = false;
        if (!right.canWrite.has_value() && (mask & FILE_WRITE_DATA))
            right.canWrite = false;
        if (!right.canExecute.has_value() && (mask & FILE_TRAVERSE))
            right.canExecute = false;
    }

    void set(const Sid &sid, DWORD mask) noexcept {
        ASSERT(sid);
        (*this)[sid] = {mask & FILE_READ_DATA, mask & FILE_WRITE_DATA,
                        mask & FILE_TRAVERSE};
    }

    void setOwner(const Sid &sid) noexcept {
        // Impute all rights to the owner
        // We could call GetEffectiveRightsFromAcl here, but it's slow,
        // inaccurate, and error-prone If we need to calculate effective rights,
        // call AuthzAccessCheck instead
        set(sid, FILE_READ_DATA | FILE_WRITE_DATA | FILE_TRAVERSE);

        m_owner = sid;
    }

    auto getOwner() const noexcept { return m_owner; }

    // Walk the entries in the DACL and build a map of each SID's permissions
    Error importDacl(PSECURITY_DESCRIPTOR sd) noexcept {
        BOOL ignored;
        PACL dacl = nullptr;
        if (!::GetSecurityDescriptorDacl(sd, &ignored, &dacl, &ignored))
            return APERRL(Permissions, ::GetLastError(),
                          "Failed to retrieve file DACL");

        // If the function succeeds but no DCAL is returned, the object has no
        // permissions set
        if (!dacl) return {};

        for (decltype(dacl->AceCount) i = 0; i < dacl->AceCount; ++i) {
            PACE_HEADER header;
            if (!::GetAce(dacl, i, _reCast<LPVOID *>(&header)))
                return APERRL(Permissions, ::GetLastError());

            switch (header->AceType) {
                case ACCESS_ALLOWED_ACE_TYPE: {
                    auto ace = _reCast<PACCESS_ALLOWED_ACE>(header);
                    if (Sid::supported(&ace->SidStart))
                        applyAllow(Sid::fromPtr(&ace->SidStart), ace->Mask);
                    break;
                }
                case ACCESS_DENIED_ACE_TYPE: {
                    // ACCESS_DENIED entries trump everything else
                    auto ace = _reCast<PACCESS_DENIED_ACE>(header);
                    if (Sid::supported(&ace->SidStart))
                        applyDeny(Sid::fromPtr(&ace->SidStart), ace->Mask);
                    break;
                }
                case ACCESS_ALLOWED_CALLBACK_ACE_TYPE:
                case ACCESS_DENIED_CALLBACK_ACE_TYPE:
                    // TODO: These are Dynamic Access Control records that must
                    // be evaluated by calling AuthzAccessCheck
                    break;
            }
        }
        return {};
    }

    operator PermissionSet() const noexcept {
        PermissionSet permSet;
        if (m_owner) permSet.ownerId = _ts(m_owner);
        for (auto &[sid, rights] : *this) {
            permSet.perms.insert(
                Permission{.principalId = _ts(sid), .rights = rights});
        }
        return permSet;
    }

protected:
    Sid m_owner;
};

}  // namespace engine::perms
