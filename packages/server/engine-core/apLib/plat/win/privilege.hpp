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

namespace ap::plat {

// Add privileges needed to grant permissions for successful
// store/recover
inline Error modifyPrivilege(LPCTSTR szPrivilege, bool fEnable) noexcept {
    // Open the process token for this process.
    wil::unique_handle hToken;
    if (!::OpenProcessToken(GetCurrentProcess(),
                            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hToken))
        return APERR(::GetLastError(), "OpenProcessToken");

    // Get the local unique ID for the privilege.
    LUID luid;
    if (!::LookupPrivilegeValue(nullptr, szPrivilege, &luid))
        return APERR(::GetLastError(), "LookupPrivilegeValue", szPrivilege);

    // Assign values to the TOKEN_PRIVILEGE structure.
    TOKEN_PRIVILEGES NewState;
    NewState.PrivilegeCount = 1;
    NewState.Privileges[0].Luid = luid;
    NewState.Privileges[0].Attributes = (fEnable ? SE_PRIVILEGE_ENABLED : 0);

    if (!::AdjustTokenPrivileges(hToken.get(), false, &NewState, 0, nullptr,
                                 nullptr))
        return APERR(::GetLastError(), "AdjustTokenPrivileges", szPrivilege);

    return {};
}

// Add privileges needed to grant permissions for successful store/recover
inline Error addRights() noexcept {
    // Set all required privileges
    return modifyPrivilege(SE_SECURITY_NAME, true) ||
           modifyPrivilege(SE_BACKUP_NAME, true) ||
           modifyPrivilege(SE_RESTORE_NAME, true) ||
           modifyPrivilege(SE_LOCK_MEMORY_NAME, true) ||
           modifyPrivilege(SE_TIME_ZONE_NAME, true);
}

}  // namespace ap::plat
