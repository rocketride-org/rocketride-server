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
// Helper class to manage a sid which is a really old school c
// api that is not const aware and all based around void *'s
class Sid {
public:
    _const auto LogLevel = Lvl::Permissions;

    Sid() = default;
    Sid(const Sid&) = default;
    Sid(Sid&&) = default;

    Sid& operator=(const Sid& sid) = default;

    ~Sid() = default;

    bool operator!=(const Sid& sid) const {
        return _cast<InputData>(*this) != _cast<InputData>(sid);
    }

    bool operator==(const Sid& sid) const {
        return _cast<InputData>(*this) == _cast<InputData>(sid);
    }

    bool empty() const noexcept { return m_length == 0; }

    explicit operator bool() const noexcept { return !empty(); }

    // Some of well known accounts are not supported
    static bool supported(void* sid) noexcept {
        ASSERT(sid && ::IsValidSid(sid));

        return !(  // not one of the following

            // Local System, Local Service or Network Service
            ::IsWellKnownSid(sid, WinLocalSystemSid) ||
            ::IsWellKnownSid(sid, WinLocalServiceSid) ||
            ::IsWellKnownSid(sid, WinNetworkServiceSid) ||

            // Contextual accounts, such the current user, all authenticated
            // users etc.
            ::IsWellKnownSid(sid, WinInteractiveSid) ||
            ::IsWellKnownSid(sid, WinAuthenticatedUserSid));
    }

    // Administrators, Users or Guests
    bool builtinSecurityGroup() const noexcept {
        if (empty()) return false;

        return ::IsWellKnownSid(ptr(), WinBuiltinAdministratorsSid) ||
               ::IsWellKnownSid(ptr(), WinBuiltinUsersSid) ||
               ::IsWellKnownSid(ptr(), WinBuiltinGuestsSid);
    }

    bool equals(void* sid) const noexcept {
        ASSERT(sid && ::IsValidSid(sid));

        if (empty()) return false;

        return ::EqualSid(ptr(), sid);
    }

    SID_IDENTIFIER_AUTHORITY authority() const noexcept {
        if (empty()) return {};

        auto authority = ::GetSidIdentifierAuthority(ptr());
        if (!authority) {
            // This should only be possible if the SID is invalid
            LOGT("GetSidIdentifierAuthority failed", ::GetLastError());
            return {};
        }

        return *authority;
    }

    size_t subauthorityCount() const noexcept {
        if (empty()) return 0;

        auto count = ::GetSidSubAuthorityCount(ptr());
        if (!count) {
            // This should only be possible if the SID is invalid
            LOGT("GetSidSubAuthorityCount failed", ::GetLastError());
            return {};
        }

        return _cast<size_t>(*count);
    }

    DWORD subauthority(size_t index) const noexcept {
        auto value = ::GetSidSubAuthority(ptr(), _cast<DWORD>(index));
        if (!value) {
            // This should only be possible if the SID is invalid or if the
            // index is out of bounds
            LOGT("GetSidSubAuthority failed", ::GetLastError());
            return {};
        }

        return *value;
    }

    // Extract the last subauthority, which will be the relative ID (AKA Rid)
    DWORD relativeId() const noexcept {
        auto count = subauthorityCount();
        if (!count) return {};

        return subauthority(count - 1);
    }

    // Get the SID of the AD domain or machine to which the SID belongs
    Sid domainSid() const noexcept {
        unsigned char domainSid[SECURITY_MAX_SID_SIZE];
        auto domainSidLength = _cast<DWORD>(std::size(domainSid));
        // Failures are expected; do not log errors
        if (!::GetWindowsAccountDomainSid(ptr(), domainSid, &domainSidLength))
            return {};

        return fromPtr(domainSid, domainSidLength);
    }

    // Implement < operator so Sid can be used as a std::map key
    bool operator<(const Sid& sid) const noexcept {
        return _cast<InputData>(*this) < _cast<InputData>(sid);
    }

    template <typename T = void>
    T* ptr() const noexcept {
        if (!empty()) return _reCast<T*>(_constCast<uint8_t*>(&m_sid.front()));
        return nullptr;
    }

    // DataView conversion operator for use in hashing
    operator InputData() const noexcept { return {&m_sid.front(), m_length}; }

    static Sid fromPtr(void* sid, size_t length) noexcept {
        if (!sid) return {};

        ASSERT(length <= SECURITY_MAX_SID_SIZE);
        Sid result;
        std::memcpy(&result.m_sid.front(), sid, length);
        result.m_length = length;
        return result;
    }

    static Sid fromPtr(void* sid) noexcept {
        if (!sid) return {};

        ASSERT(IsValidSid(sid));
        return fromPtr(sid, ::GetLengthSid(sid));
    }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        if (empty()) return;

        char* string = {};
        ASSERTD(::ConvertSidToStringSidA(ptr(), &string) && string);

        buff << string;
        ::LocalFree(string);
    }

    template <typename Buffer>
    static Error __fromString(Sid& sid, const Buffer& buff) noexcept {
        auto sidString = buff.toString();
        if (!sidString) return {};

        PSID psid;
        if (!::ConvertStringSidToSidA(sidString, &psid))
            return APERRL(Permissions, ::GetLastError(),
                          "ConvertStringSidToSidA failed", sidString);

        size_t length = ::GetLengthSid(psid);
        ASSERTD(length <= SECURITY_MAX_SID_SIZE);

        std::memcpy(&sid.m_sid.front(), psid, length);
        sid.m_length = length;

        ::LocalFree(psid);
        return {};
    }

private:
    Array<uint8_t, SECURITY_MAX_SID_SIZE> m_sid;
    size_t m_length = {};
};

}  // namespace engine::perms

// Implement std::hash for Sid so it can be used as a std::unordered_map key
template <>
struct std::hash<::engine::perms::Sid> {
    size_t operator()(const ::engine::perms::Sid& sid) const noexcept {
        return std::hash<::ap::InputData>()(sid);
    }
};
