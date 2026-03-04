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

//-----------------------------------------------------------------------------
//
//	Declares the object for working with Ms Email.
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::outlook {
using namespace utility;

//-------------------------------------------------------------------------
/// @details
///		Begins operations on this filter. Sets up commonly used members
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::beginFilterInstance() noexcept {
    return Parent::beginFilterInstance();
}

//-------------------------------------------------------------------------
/// @details
///		Destructor - ends the endpoint. We need to do this here since, if
///		we just let the IServiceEndpoint do it, it will only clean up
///		itself, not our allocations
//-------------------------------------------------------------------------
IFilterEndpoint::~IFilterEndpoint() { endEndpoint(); };

//-------------------------------------------------------------------------
/// @details
///		Begins operations on this filter. Sets up commonly used members
///	@param[in]	openMode
///		Mode that endpoint is opened in
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterEndpoint::beginEndpoint(OPEN_MODE openMode_) noexcept {
    LOGT("Creating {} endpoint", config.logicalType);

    // Call the parent first so open mode is set
    if (auto ccode = Parent::beginEndpoint(openMode_)) return ccode;

    // Returns if processing "deleted" resource
    // Prevents connection to the deleted resource which might not be available
    // at all
    bool deleted = config.serviceConfig.lookup<bool>("deleted");
    if (deleted) return {};

    // Do not call beginEndpoint/endEndpoint for commitScan
    if (config.jobConfig["type"].asString() != task::commitScan::Task::Type) {
        auto ccode = createClient(this);
        if (ccode.hasCcode()) return ccode.ccode();

        m_msEmailNode = ccode.value();
    }

    return {};
}

//-----------------------------------------------------------------
/// @details
///		Make static, finalized configs
//-----------------------------------------------------------------
Error IFilterEndpoint::getConfigSubKey(Text& key) noexcept {
    if (config.serviceMode == SERVICE_MODE::SOURCE) {
        key = _ts(m_msConfig->m_tenantId);
        if (!m_msConfig->m_isEnterprise)
            key += _ts("_"_tv + m_msConfig->m_refreshTokenHash);
    } else {
        key = _ts(m_msConfig->m_tenantId, "/", config.storePath);
    }
    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function is called as one of the last steps in
///     construction of the endpoint. We will use it to parse
///     the email information
///	@param[in]	jobConfig
///		The full job config
///	@param[in]	taskConfig
///		The task info
///	@param[in]	serviceConfig
///		The service config
///	@returns
///		Error
//-----------------------------------------------------------------
Error IFilterEndpoint::setConfig(const json::Value& jobConfig,
                                 const json::Value& taskConfig,
                                 const json::Value& serviceConfig) noexcept {
    // Let the parent decode everything first
    if (auto ccode = Parent::setConfig(jobConfig, taskConfig, serviceConfig))
        return ccode;

    // Then parse the configuration with type-specific logic
    if (auto ccode = OutlookConfig::__fromJson(
            config, m_msConfig, config.logicalType == TypeEnterprise))
        return ccode;

    return {};
}

//-----------------------------------------------------------------
/// @details
///        Perform a scan for objects Call the callback with each
///        object found.
///    @param[in]    path
///        Path to scanned object, includes account name which is cut off from
///        processing, and later added if needed
///    @param[in]    callback
///        Pass a Entry with all the information filled
//-----------------------------------------------------------------
Error IFilterEndpoint::scanObjects(Path& path,
                                   const ScanAddObject& callback) noexcept {
    // Create getSyncToken callback
    const msNode::GetSyncTokenCallBack getSyncTokenFn =
        [this](TextView key) -> ErrorOr<Text> { return getSyncToken(key); };
    // Create setSyncToken callback
    const msNode::SetSyncTokenCallBack setSyncTokenFn =
        [this](TextView key, TextView value) -> Error {
        return setSyncToken(key, value);
    };

    if (path.count()) {
        if (auto ccode = m_msEmailNode->getEmailsAndFolders(
                path, callback, setSyncTokenFn, getSyncTokenFn)) {
            LOGT("Failed to scan path '{}': {}", path, ccode);
            return {};
        }
    } else if (auto ccode = m_msEmailNode->getAllUsersEmailsAndFolders(
                   callback, setSyncTokenFn, getSyncTokenFn)) {
        LOGT("Failed to scan all users: {}", ccode);
        return {};
    }

    return {};
}

//-----------------------------------------------------------------
/// @details
///        Check if sync endpoint capability
//-----------------------------------------------------------------
bool IFilterEndpoint::isSyncEndpoint() noexcept {
    // Get protocol
    auto scanProtocol = config.serviceConfig.lookup<Text>("type");

    // Get the capability flags of this protocol
    uint32_t caps = 0;
    if (Url::getCaps(scanProtocol.toView(), caps)) return false;

    return 0 != (caps & Url::PROTOCOL_CAPS::SYNC);
}

Error IFilterEndpoint::endEndpoint() noexcept {
    // And call the parent
    if (auto ccode = Parent::endEndpoint()) return ccode;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		end the endpoint operation
//-------------------------------------------------------------------------
ErrorOr<std::shared_ptr<MsEmailNode>> IFilterEndpoint::createClient(
    IFilterEndpoint* parent) noexcept {
    // Start the endpoint
    auto msEmailNode = std::make_shared<MsEmailNode>(m_msConfig, parent);

    // Parse it and get the keys, bucket, etc
    auto ccode = msEmailNode->createConnection();
    if (ccode) return ccode;
    return msEmailNode;
}

//-------------------------------------------------------------------------
/// @details
///		get the mutex
//-------------------------------------------------------------------------
std::mutex& IFilterEndpoint::getPathLock() noexcept { return m_pathLock; }

//-------------------------------------------------------------------------
/// @details
///		get the foldermap
//-------------------------------------------------------------------------
FoldersMap& IFilterEndpoint::getFolderMap() noexcept { return m_folders; }
//-------------------------------------------------------------------------
/// @details
///		create client for connection to sharepoint
//-------------------------------------------------------------------------
Error IFilterInstance::getClient() noexcept {
    // Start the endpoint
    // Parse it and get the keys, bucket, etc
    auto ccode = endpoint.createClient(&endpoint);
    if (ccode.hasCcode()) return ccode.ccode();

    m_msEmailNode = ccode.value();

    return {};
}

}  // namespace engine::store::filter::outlook