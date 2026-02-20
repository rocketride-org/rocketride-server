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

namespace ap::file::smb {

struct MountCtx {
    MountCtx() noexcept = default;

    MountCtx(const Utf16 &uncPath, bool connected) noexcept
        : uncPath(uncPath), connected(connected) {}

    ~MountCtx() noexcept {
        if (uncPath && connected) {
            // FALSE = don't forcibly disconnect all clients connected to the
            // share, as other engine instances may be using it
            if (auto error = ::WNetCancelConnection2W(uncPath, 0, FALSE))
                LOG(Smb, "Failed to close SMB share", error, uncPath);
        }
    }

    // Disable copy
    MountCtx(const MountCtx &) = delete;
    MountCtx(MountCtx &&) = default;
    MountCtx &operator=(const MountCtx &) = delete;
    MountCtx &operator=(MountCtx &&) = default;

    Utf16 uncPath;
    bool connected = {};
};

inline Error init() noexcept {
    // No initialization necessary on Windows
    return {};
}

inline ErrorOr<std::vector<MountCtx>> mount(const Share &share) noexcept {
    _const size_t maxNumberOfAttempts = 10;
    _const auto defaultDuration = 1000ms;
    if (!share) return APERRL(Smb, Ec::InvalidParam, "Invalid share", share);
    std::vector<MountCtx> mounts;
    mounts.reserve(share.names.size());

    for (const auto &name : share.names) {
        Utf16 uncPath = string::format("\\\\{}\\{}", share.server, name);
        Utf16 pass = share.password;
        Utf16 user = share.username;
        NETRESOURCEW resource = {};
        resource.dwType = RESOURCETYPE_DISK;
        resource.lpRemoteName = _constCast<Utf16Chr *>(uncPath.c_str());

        if (share.username)
            LOG(Smb, "Opening SMB share", uncPath, "as", share.username);
        else
            LOG(Smb, "Opening SMB share", uncPath);

        DWORD connectionError = 0;
        Error error = {};
        for (size_t attemptNo = 1; attemptNo <= maxNumberOfAttempts;
             ++attemptNo) {
            error = {};
            connectionError =
                ::WNetAddConnection2W(&resource, pass, user, CONNECT_TEMPORARY);

            // WNetAddConnection2W often returns credential-related errors when
            // the share is actually accessible to the current user Verify
            // whether share is accessible before returning any errors
            if (connectionError)
                LOG(Smb,
                    "WNetAddConnection2W failed (attempt {}); checking whether "
                    "error is spurious",
                    attemptNo, APERR(connectionError));

            if (auto stats =
                    stat(string::format("//{}/{}", share.server, name));
                !stats) {
                LOG(Smb,
                    "Failed to enumerate contents of SMB share (attempt {})",
                    attemptNo, stats.ccode());

                // If WNetAddConnection2W failed, return that error
                if (connectionError)
                    error = APERRL(Smb, connectionError,
                                   "Failed to open SMB share '", uncPath,
                                   "' after", attemptNo, "attempts");
                else
                    // Otherwise, return the failure to stat the directory
                    error =
                        APERRL(Smb, stats.ccode(), "Failed to stat SMB share '",
                               uncPath, "' after", attemptNo, "attempts");
            }

            if (!error.isSet()) break;
            async::sleep(defaultDuration);
        }

        if (error.isSet()) {
            LOG(Always, "Failed to mount share `", name,
                "`, skipping it; error code is: ", error);
            continue;
        }

        // If we got an error connecting, don't disconnect the share on exit
        LOG(Smb, "Successfully enumerated contents of SMB share", name);
        mounts.push_back(MountCtx{uncPath, !connectionError});
    }

    return _mv(mounts);
}

inline ErrorOr<HANDLE> impersonateNetworkService() noexcept {
    HANDLE hToken = {};
    if (!::LogonUserW(L"NETWORK SERVICE", L"NT AUTHORITY", nullptr,
                      LOGON32_LOGON_NEW_CREDENTIALS, LOGON32_PROVIDER_WINNT50,
                      &hToken))
        return APERRL(Smb, ::GetLastError(),
                      "Failed to impersonate network service account");

    LOG(Smb, "Successfully impersonated network service account");
    return hToken;
}

inline ErrorOr<std::vector<Text>> enumShares(const Share &share,
                                             TextView originalShareName) {
    _const size_t maxNumberOfAttempts = 10;
    _const auto defaultDuration = 1000ms;

    std::vector<Text> shares;
    // Create a glob matcher
    globber::Glob matcher;
    if (auto ccode = globber::createPathMatcher(originalShareName, 0, matcher,
                                                plat::PathCaseMode))
        return ccode;

    globber::Globs includes;
    includes.add(_mv(matcher));

    Utf16 uncPath = string::format("\\\\{}", share.server);
    Utf16 pass = share.password;
    Utf16 user = share.username;
    NETRESOURCEW nr = {};
    nr.dwType = RESOURCETYPE_ANY;
    nr.lpRemoteName = _constCast<Utf16Chr *>(uncPath.c_str());

    if (share.username)
        LOG(Smb, "Opening SMB server", uncPath, "as", share.username);
    else
        LOG(Smb, "Opening SMB server", uncPath);

    DWORD connectionError = 0;
    Error error = {};
    for (size_t attemptNo = 1; attemptNo <= maxNumberOfAttempts; ++attemptNo) {
        error = {};
        connectionError =
            ::WNetAddConnection2W(&nr, pass, user, CONNECT_TEMPORARY);

        if (!connectionError) break;
        async::sleep(defaultDuration);
    }
    if (connectionError) {
        return APERRL(Smb, connectionError, "Failed to open SMB server '",
                      uncPath, "' after", maxNumberOfAttempts,
                      "attempts, error code is", connectionError);
    }

    DWORD dwRetVal;
    unsigned char buffer[64 * 1024];
    HANDLE hEnum;

    // Open the enumeration
    dwRetVal =
        WNetOpenEnumW(RESOURCE_GLOBALNET, RESOURCETYPE_DISK, 0, &nr, &hEnum);
    if (dwRetVal != NO_ERROR) {
        return APERRL(Smb, ::GetLastError(),
                      "Error: failed to open enumeration");
    }

    Error errorCode = {};

    // Go get the share
    do {
        DWORD cEntries = _cast<DWORD>(-1);
        DWORD cbBuffer;
        NETRESOURCEW *pNet = (NETRESOURCEW *)buffer;

        // Initialize the buffer.
        memset(buffer, 0, sizeof(buffer));

        // Setup available size
        cbBuffer = sizeof(buffer);

        // Call the WNetEnumResource function to continue the enumeration.
        dwRetVal = WNetEnumResourceW(hEnum,       // resource handle
                                     &cEntries,   // defined locally as -1
                                     pNet,        // Resource to search
                                     &cbBuffer);  // buffer size

        // If the call succeeds, loop through the structures.
        if (dwRetVal == NO_ERROR) {
            for (DWORD i = 0; i < cEntries; i++) {
                // Call an application-defined function to
                //  display the contents of the NETRESOURCE structures.
                Text shareName = Path(pNet[i].lpRemoteName).at(1);
                if (includes.matches(shareName)) shares.push_back(shareName);
            }
        } else if (dwRetVal == ERROR_NO_MORE_ITEMS) {
            // No more items so just break out of the do loop
            break;
        } else {
            // Failed!
            errorCode = APERRL(Smb, ::GetLastError(),
                               "Error: failed to read enumeration");
            break;
        }
    } while (true);

    dwRetVal = WNetCloseEnum(hEnum);
    if (dwRetVal != NO_ERROR)
        errorCode =
            APERRL(Smb, ::GetLastError(), "Error: failed to close enumeration");

    if (errorCode.isSet()) return errorCode;

    return shares;
}

}  // namespace ap::file::smb
