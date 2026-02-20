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

#include <apLib/ap.h>

namespace {
auto& mountedShares() noexcept {
    static std::vector<file::smb::Share> shares;
    return shares;
}
}  // namespace

namespace ap::file::smb {

Error Client::init(const Text& username, const Text& password) noexcept {
    auto lock = m_lock.lock();
    if (m_api) return {};

    // Load the libsmbclient library
    auto api = load();
    if (!api) return api.ccode();

    // Save credentials
    m_username = username;
    m_password = password;

    // Create and initialize the libsmbclient context
    auto ctx = api->new_context();
    if (!ctx) return APERRT(errno, "Failed to create SMB context");

    util::Guard ctxCleanup{[&] { api->free_context(ctx, 0); }};

    if (!api->init_context(ctx))
        return APERRT(errno, "Failed to initialize SMB context");

    // Configure logging
    if (log::isLevelEnabled(Lvl::Smb)) {
        api->setDebug(ctx, 3);

        // smbc_setLogCallback is not supported by version 4.3.8, which is the
        // default for Ubuntu 16
        if (api->setLogCallback) {
            (*api->setLogCallback)(
                ctx, nullptr,
                [](void* userData, int level, const char* msg) noexcept {
                    LOG(Smb, msg);
                });
        } else
            LOGT(
                "Installed version of libsmbclient does not support "
                "setLogCallback; libsmbclient will log to stdout");
    } else
        api->setDebug(ctx, 0);

    // Callback to supply credentials to SMB client library
    api->setFunctionAuthData(ctx, [](const char* server, const char* share,
                                     char* workgroup, int workgroupLen,
                                     char* username, int usernameLen,
                                     char* password, int passwordLen) noexcept {
        // If the username is of form "domain\user", set the workgroup and
        // username
        if (auto domain = plat::domainFromUsername(client().m_username)) {
            strncpy(workgroup, domain, workgroupLen - 1);
            strncpy(username, plat::accountFromUsername(client().m_username),
                    usernameLen - 1);
        } else
            strncpy(username, client().m_username, usernameLen - 1);

        strncpy(password, client().m_password, passwordLen - 1);
        return;
    });

    // Enable Kerberos
    api->setOptionUseKerberos(ctx, 1);
    api->setOptionFallbackAfterKerberos(ctx, 1);

    // Save the context and set it as the global libsmbclient context
    api->set_context(ctx);
    m_ctx = ctx;
    m_api = _mv(*api);
    ctxCleanup.cancel();

    LOGT("SMB client library initialized:", m_api->version());
    return {};
}

ErrorOr<std::vector<MountCtx>> Client::mount(const Share& share) noexcept {
    if (auto ccode = init(share.username, share.password)) return ccode;

    auto lock = m_lock.lock();

    // Check if we've already verified and added this share
    // Temporarily add the share to the list of mounted shares and verify it
    for (const auto& shareName : share.names) {
        if (std::find_if(m_mountedShares.begin(), m_mountedShares.end(),
                         [&share, &shareName](const auto& pair) {
                             return pair.first == share.server &&
                                    pair.second == shareName;
                         }) != m_mountedShares.end()) {
            LOGT("Share already mounted", shareName);
            continue;
        }

        m_mountedShares.emplace_back(
            std::make_pair<TextView, TextView>(share.server, shareName));
        const auto url =
            string::format("//{}/{}", share.server, shareName);  // get UNC name

        if (auto stats = stat(url); !stats) {
            // Failed; remove from list of mounted shares
            m_mountedShares.pop_back();
            LOG(Always, "Failed to mount share `", shareName,
                "`, skipping it; error code is: ", stats.ccode());
            continue;
        }

        LOGT("Mounted SMB share:", shareName);
    }

    std::vector<MountCtx> result = {MountCtx{}};
    return result;
}

ErrorOr<std::vector<Text>> Client::enumShares(
    const Share& share, TextView originalShareName) noexcept {
    if (auto ccode = init(share.username, share.password)) return ccode;

    // Check if we've already verified and added this share
    auto lock = m_lock.lock();

    std::vector<Text> shares;
    // Create a glob matcher
    globber::Glob matcher;
    if (auto ccode = globber::createPathMatcher(originalShareName, 0, matcher,
                                                plat::PathCaseMode))
        return ccode;

    globber::Globs includes;
    includes.add(_mv(matcher));

    const auto url = renderSmbUrl(share.server, "");
    LOGT("Opening SMB root directory", url);
    if (auto hDirectory = m_api->opendir(url); hDirectory >= 0) {
        LOGT("Opened SMB root directory", url, "=>", hDirectory);

        while (auto dirent = m_api->readdir(hDirectory)) {
            if (dirent->type == 3 && !Text{dirent->name}.ends_with("$") &&
                includes.matches(Text{dirent->name})) {
                LOGT("SMB entry added", dirent->name);
                shares.push_back(dirent->name);
            } else
                LOGT("SMB entry skipped", dirent->name);
        }

        LOGT("Closing SMB root directory", hDirectory);
        if (m_api->closedir(hDirectory))
            return APERRT(errno, "Failed to close directory", hDirectory);
    } else {
        LOGT("Failure while opening SMB root directory", url, "=>", hDirectory);
    }

    return shares;
}
}  // namespace ap::file::smb
