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
/// @param[in]    object
///    The object information about the object being opened
/// @returns
///    Error
//-------------------------------------------------------------------------
ErrorOr<Text> outputPermission(
    const Variant<CRef<PermissionSet>, CRef<GroupRecord>, CRef<UserRecord>>&
        arg) noexcept;

#if ROCKETRIDE_PLAT_WIN
//-------------------------------------------------------------------------
/// @details
///    Helper function to load permissions of a file, for now
///    only required in Windows as
///    it's used to check for changes in permissions
/// @param[in]    osPath
///     Path to a file
/// @returns
///     Error or PermissionSet
ErrorOr<PermissionSet> getPermissions(Text& osPath) noexcept;
#endif
}  // namespace engine::perms
