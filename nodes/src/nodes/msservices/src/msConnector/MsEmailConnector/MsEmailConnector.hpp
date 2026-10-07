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

namespace engine::store::filter::msNode::msEmailNode {
using namespace utility;
using namespace web::http;
using namespace web::http::client;
using Path = ap::file::Path;
using ScanAddObject = std::function<Error(Entry &)>;
using namespace engine::store::filter::msNode;

// active mailbox
static const std::vector<web::http::status_code> CODES_FOR_MAILBOX_SETTING = {
    web::http::status_codes::OK, web::http::status_codes::NotFound};

static const unsigned short int OUTLOOK_MAX_RETRIES = 10;

// delta key
static const Text DELTA_KEY_OUTLOOK = "deltatoken=";

// key for folder delta postfix
static const Text FOLDER_DELTA_POSTFIX = "-childFolder";

// username Position
static const int USERNAME_POS = 0;

//-------------------------------------------------------------------------
// Define outlook configuration info
//-------------------------------------------------------------------------

struct OutlookConfig : public MsConfig {
    OutlookConfig() : MsConfig(), m_folders() {}

    //-------------------------------------------------------------------------
    /// @details
    ///		list of folders in outlook
    //-------------------------------------------------------------------------
    std::list<Path> m_folders;

    //---------------------------------------------------------------------
    /// @details
    ///		Parse the service information from the given json
    ///	@param[in]	serviceConfig
    ///		json to parse from
    ///	@param[out]	outlookConfig
    ///		configuration object to set
    ///	@returns
    //---------------------------------------------------------------------
    static Error __fromJson(engine::store::IServiceConfig &serviceConfig,
                            std::shared_ptr<MsConfig> &msConfig,
                            bool isEnterprise) noexcept {
        if (serviceConfig.serviceMode != engine::store::SERVICE_MODE::SOURCE) {
            return APERR(Ec::InvalidParam,
                         "Outlook is only supported as a Source");
        }

        if (auto ccode = serviceConfig.parameters.lookupAssign(
                             "tenant", msConfig->m_tenantId) ||
                         serviceConfig.parameters.lookupAssign(
                             "clientId", msConfig->m_clientId) ||
                         serviceConfig.parameters.lookupAssign(
                             "clientSecret", msConfig->m_clientSecret) ||
                         serviceConfig.parameters.lookupAssign(
                             "refreshToken", msConfig->m_refreshToken))
            return ccode;

        // Use the protocol type to determine enterprise vs personal
        msConfig->m_isEnterprise = isEnterprise;

        if (!msConfig->m_clientId)
            return APERR(Ec::InvalidParam, "Missing required clientId");
        if (!msConfig->m_clientSecret)
            return APERR(Ec::InvalidParam, "Missing required clientSecret");
        if (msConfig->m_isEnterprise && !msConfig->m_tenantId)
            return APERR(Ec::InvalidParam,
                         "Missing required tenantId (for Enterprise account)");
        else if (!msConfig->m_isEnterprise && !msConfig->m_refreshToken)
            return APERR(
                Ec::InvalidParam,
                "Missing required refresh token (for Personal account)");

        std::hash<Text> hasher;
        msConfig->m_refreshTokenHash =
            string::toHex(hasher(msConfig->m_refreshToken));

        // Done
        return {};
    }
};

class MsEmailNode : public MsNode {
public:
    using Parent = MsNode;
    using Parent::m_msConfig;

public:
    MsEmailNode();
    MsEmailNode(std::shared_ptr<MsConfig> msConfig,
                IServiceEndpoint *parentEndpoint);
    ~MsEmailNode();

    Error setConfig(engine::store::IServiceConfig &serviceConfig) noexcept;
    Error createConnection() noexcept;
    Error getEmailsAndFolders(const Path &path, const ScanAddObject &callback,
                              const msNode::SetSyncTokenCallBack &,
                              const msNode::GetSyncTokenCallBack &) noexcept;
    Error getAllUsersEmailsAndFolders(
        const ScanAddObject &callback, const msNode::SetSyncTokenCallBack &,
        const msNode::GetSyncTokenCallBack &) noexcept;
    ErrorOr<Entry> getMetaData(const Text &userId,
                               const Text &messageId) noexcept;
    ErrorOr<std::vector<unsigned char>> getMessageInMime(
        const Entry &entry) noexcept;
    Error hasActiveMailBox(const Text &user) noexcept;
    Error getValidPaths(const Text &path,
                        std::unordered_map<Text, Text> &folders) noexcept;
    ErrorOr<Text> getMessageParent(const Text &userId,
                                   const Text &messageId) noexcept;
    ErrorOr<Text> getServicePrincipalId(const Text &clientId) noexcept;
    ErrorOr<std::vector<Text>> getAppRoleAssignments(
        const Text &clientId, const Text &servicePrincipalId) noexcept;

private:
    ErrorOr<MsContainer> getEmails(const Text &userId, const Text &pathId,
                                   const Text &syncToken) noexcept;
    ErrorOr<MsContainer> getPaths(const Text &userId, const Text &pathId,
                                  const Text &) noexcept;
    ErrorOr<Text> findPathIdAndGetParentsContainer(
        const Entry &rootEntry, const Path &path,
        MsContainer &parentsContainer) noexcept;
    ErrorOr<Entry> getRootInfo(const Text &userId, const Text &path) noexcept;
    ErrorOr<MsContainer> getDeltaFolders(
        const Text &userId, const Text &pathId,
        const msNode::GetSyncTokenCallBack &) noexcept;
};
}  // namespace engine::store::filter::msNode::msEmailNode
