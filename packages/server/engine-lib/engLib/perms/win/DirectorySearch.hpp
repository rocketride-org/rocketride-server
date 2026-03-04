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

_COM_SMARTPTR_TYPEDEF(IDirectorySearch, __uuidof(IDirectorySearch));

class DirectorySearch {
public:
    _const auto LogLevel = Lvl::Permissions;

    DirectorySearch(const Text& ldapPath, const Text& filter) noexcept(false)
        : m_ldapPath{ldapPath}, m_filter{filter} {
        // Open searcher object for the LDAP path
        if (HRESULT hr =
                ADsGetObject(ldapPath.ptr<WCHAR>(), IID_IDirectorySearch,
                             _reCast<void**>(&m_searcher));
            FAILED(hr))
            APERRT_THROW(hr);

        // Execute the search, requesting only the SID
        LPCWSTR attributes[] = {L"objectSid"};
        if (HRESULT hr = m_searcher->ExecuteSearch(
                const_cast<LPWSTR>(filter.ptr<WCHAR>()),
                const_cast<LPWSTR*>(attributes),
                _cast<DWORD>(std::size(attributes)), &m_hSearch))
            APERRT_THROW(hr);
    }

    DirectorySearch(const DirectorySearch&) = delete;
    DirectorySearch(DirectorySearch&&) = delete;

    ~DirectorySearch() noexcept {
        // Close the search
        if (m_searcher && m_hSearch) {
            if (auto hr = m_searcher->AbandonSearch(m_hSearch))
                LOGT("IDirectorySearch::AbandonSearch failed", hr);
        }
    }

    Opt<perms::Sid> next() noexcept(false) {
        // Fetch the next row
        if (HRESULT hr = m_searcher->GetNextRow(m_hSearch)) {
            if (hr == S_ADS_NOMORE_ROWS) return {};
            APERRT_THROW(hr, "IDirectorySearch::GetNextRow failed");
        }

        // Get the SID from the row
        ADS_SEARCH_COLUMN column = {};
        if (HRESULT hr = m_searcher->GetColumn(
                m_hSearch, const_cast<LPWSTR>(L"objectSid"), &column))
            APERRT_THROW(hr, "IDirectorySearch::GetColumn failed");
        util::Guard columnCleanup{[&]() {
            if (HRESULT hr = m_searcher->FreeColumn(&column))
                LOGT("IDirectorySearch::FreeColumn failed", hr);
        }};

        if (column.dwADsType != ADSTYPE_OCTET_STRING)
            APERRT_THROW(Ec::Unexpected,
                         "objectSid column is of an unexpected type",
                         column.dwADsType);

        auto sid = perms::Sid::fromPtr(column.pADsValues->OctetString.lpValue,
                                       column.pADsValues->OctetString.dwLength);
        if (!sid)
            APERRT_THROW(Ec::Unexpected,
                         "objectSid column contained a null SID");

        return sid;
    }

    TextView ldapPath() const noexcept { return m_ldapPath; }

    TextView filter() const noexcept { return m_filter; }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << ldapPath() << ": " << filter();
    }

protected:
    Text m_ldapPath;
    Text m_filter;
    IDirectorySearchPtr m_searcher;
    ADS_SEARCH_HANDLE m_hSearch = {};
};

}  // namespace engine::perms::adsi