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

enum { cUidNobody = 65534, cGidNoGroup = 65534 };

inline Text renderUid(uid_t uid) noexcept { return _fmt("U:{}", uid); }

inline Text renderUid(const struct passwd& user) noexcept {
    return renderUid(user.pw_uid);
}

inline bool isValidUid(TextView string) noexcept {
    return string.length() >= 3 && string.startsWith("U:") &&
           string::isNumeric(string.substr(2));
}

inline ErrorOr<uid_t> parseUid(TextView string) noexcept {
    if (!isValidUid(string))
        return APERRL(Permissions, Ec::InvalidParam, "Invalid UID string",
                      string);
    return _fs<uid_t>(string.substr(2));
}

inline Text renderGid(gid_t gid) noexcept { return _fmt("G:{}", gid); }

inline Text renderGid(const struct group& group) noexcept {
    return renderGid(group.gr_gid);
}

inline bool isValidGid(TextView string) noexcept {
    return string.length() >= 3 && string.startsWith("G:") &&
           string::isNumeric(string.substr(2));
}

inline ErrorOr<gid_t> parseGid(TextView string) noexcept {
    if (!isValidGid(string))
        return APERRL(Permissions, Ec::InvalidParam, "Invalid GID string",
                      string);
    return _fs<gid_t>(string.substr(2));
}

inline Rights makeOwnerRights(mode_t mode) noexcept {
    Rights rights;
    if (mode & S_IRUSR) rights.canRead = true;
    if (mode & S_IWUSR) rights.canWrite = true;
    return rights;
}

inline Rights makeGroupRights(mode_t mode) noexcept {
    Rights rights;
    if (mode & S_IRGRP) rights.canRead = true;
    if (mode & S_IWGRP) rights.canWrite = true;
    return rights;
}

inline auto lockPasswordDatabase() noexcept {
    // The Unix user database API's are supposed to be thread-safe but
    // concurrent access is causing crashes in newer Linux versions
    static async::MutexLock passwordDatabaseMutex;
    return passwordDatabaseMutex.lock();
}

inline ErrorOr<Text> getUsername(uid_t uid) noexcept {
    struct passwd user;
    char buffer[1_kb];
    struct passwd* ignore;
    auto lock = lockPasswordDatabase();
    if (auto error = getpwuid_r(uid, &user, buffer, sizeof(buffer), &ignore))
        return APERRL(Permissions, Ec::NotFound, "Unable to resolve user", uid,
                      error);
    if (!ignore)
        return APERRL(Permissions, Ec::NotFound, "Unable to resolve user", uid);
    return user.pw_name;
}

template <typename Callback>
ErrorOr<Text> expandGroup(gid_t gid, Callback&& callback) noexcept {
    LOG(Permissions, "Expanding group: {}", gid);
    struct group group;
    size_t groupBufferLength = 4_kb;
    memory::Data<char> groupBuffer(groupBufferLength);
    groupBuffer.resize(groupBufferLength);
    struct group* ignore;
    auto lock = lockPasswordDatabase();
    while (auto error = getgrgid_r(gid, &group, groupBuffer, groupBufferLength,
                                   &ignore)) {
        if (error == ERANGE) {
            groupBufferLength *= 2;
            groupBuffer.resize(groupBufferLength);
        } else
            return APERRL(Permissions, Ec::NotFound, "Unable to resolve group",
                          gid, error);
    }
    if (!ignore)
        return APERRL(Permissions, Ec::NotFound, "Unable to resolve group",
                      gid);

    ASSERT(group.gr_mem);
    char memberBuffer[1_kb];
    for (size_t i = {}; group.gr_mem[i]; ++i) {
        struct passwd member;
        struct passwd* ignore;
        if (auto error = getpwnam_r(group.gr_mem[i], &member, memberBuffer,
                                    sizeof(memberBuffer), &ignore)) {
            LOG(Permissions, "Group member not found", group.gr_name,
                group.gr_mem[i], error);
            continue;
        }

        if (auto ccode = callback(member); ccode && ccode != Ec::NotFound)
            return ccode;
    }
    return group.gr_name;
}

}  // namespace engine::perms
