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
#pragma comment(lib, "Activeds.lib")

namespace engine::perms::adsi {

_COM_SMARTPTR_TYPEDEF(IDirectoryObject, __uuidof(IDirectoryObject));

class DirectoryObject {
public:
    _const auto LogLevel = Lvl::Permissions;

    DirectoryObject(const perms::Sid& sid) noexcept(false) : m_sid{sid} {
        const auto ldapPath = string::format("LDAP://<SID={}>", sid);
        if (HRESULT hr =
                ADsGetObject(ldapPath.ptr<WCHAR>(), IID_IDirectoryObject,
                             _reCast<void**>(&m_object));
            FAILED(hr))
            APERRT_THROW(hr);
    }

    DirectoryObject(const Utf16& dn) noexcept(false) : m_dn{dn} { open(dn); }

    DirectoryObject(const Utf16View& dn) noexcept(false) : m_dn{dn} {
        open(dn);
    }

    ~DirectoryObject() = default;
    DirectoryObject(const DirectoryObject&) = delete;
    DirectoryObject(DirectoryObject&&) = default;

    const perms::Sid& sid() const noexcept(false) {
        if (!m_sid) m_sid = adsi::Sid(*m_object);
        return m_sid;
    }

    const Utf16& dn() const noexcept(false) {
        if (!m_dn) m_dn = adsi::Dn{*m_object}.value();
        return m_dn;
    }

    adsi::SidHistory sidHistory() const noexcept(false) {
        return adsi::SidHistory{*m_object};
    }

    adsi::DnStringArray groupDns() const noexcept(false) {
        return adsi::DnStringArray{*m_object, L"memberOf"};
    }

    adsi::DnStringArray memberDns() const noexcept(false) {
        return adsi::DnStringArray{*m_object, L"member"};
    }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << dn();
    }

protected:
    void open(const Utf16View& dn) noexcept(false) {
        const Utf16 ldapPath = L"LDAP://" + dn;
        if (HRESULT hr = ADsGetObject(ldapPath, IID_IDirectoryObject,
                                      _reCast<void**>(&m_object));
            FAILED(hr))
            APERRT_THROW(hr);
    }

protected:
    IDirectoryObjectPtr m_object;
    mutable perms::Sid m_sid;
    mutable Utf16 m_dn;
};

}  // namespace engine::perms::adsi
