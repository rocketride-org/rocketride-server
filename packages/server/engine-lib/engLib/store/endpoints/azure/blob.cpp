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

//-----------------------------------------------------------------------------
//
//	Declares the object for working with Azure blob storage.
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::azure {

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
///		Begins operations on this filter. Sets up commonly used members
///	@param[in]	openMode
///		Mode that endpoint is opened in
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterEndpoint::beginEndpoint(OPEN_MODE openMode_) noexcept {
    LOGT("Creating {} endpoint", Type);

    Error ccode;

    if (ccode = Parent::beginEndpoint(openMode_)) return ccode;

    // Parse it and get the keys, bucket, etc
    if (ccode = BlobConfig::__fromJson(config, m_blobConfig)) return ccode;

    // Returns if processing "deleted" resource
    // Prevents connection to the deleted resource which might not be available
    // at all
    if (m_blobConfig.deleted) return {};

    // https for ssl connection
    auto account = _fmt("https://{}.{}", m_blobConfig.accountName,
                        m_blobConfig.endpointSuffix);

    std::shared_ptr<Azure::Storage::StorageSharedKeyCredential>
        sharedKeyCredential(new Azure::Storage::StorageSharedKeyCredential(
            m_blobConfig.accountName, m_blobConfig.accountKey));

    m_client.m_blobServiceClient.reset(
        new Azure::Storage::Blobs::BlobServiceClient(account,
                                                     sharedKeyCredential));

    // update the include and exclude paths
    {
        const auto applyAccountName = localfcn(TextView sectionName) {
            LOGT("Modifying {} to include account name {}", sectionName,
                 m_blobConfig.accountName);

            auto &paths = config.serviceConfig[sectionName];
            for (auto &path : paths) {
                path["path"] = _tj(m_blobConfig.accountName + "/" +
                                   path["path"].asString());
            }
        };

        applyAccountName("include"_tv);
        applyAccountName("exclude"_tv);
    }

    return {};
}

//-----------------------------------------------------------------
/// @details
///		Make static, finalized configs
//-----------------------------------------------------------------
Error IFilterEndpoint::getConfigSubKey(Text &key) noexcept {
    if (config.serviceMode == SERVICE_MODE::SOURCE) {
        key = _ts(m_blobConfig.accountName, "/", m_blobConfig.endpointSuffix);
    } else {
        key = _ts(m_blobConfig.accountName, "/", m_blobConfig.endpointSuffix,
                  "/", config.storePath);
    }
    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function is called as one of the last steps in
///     construction of the endpoint. We will use it to parse
///     the azure information
///	@param[in]	jobConfig
///		The full job config
///	@param[in]	taskConfig
///		The task info
///	@param[in]	serviceConfig
///		The service config
///	@returns
///		Error
//-----------------------------------------------------------------
Error IFilterEndpoint::setConfig(const json::Value &jobConfig,
                                 const json::Value &taskConfig,
                                 const json::Value &serviceConfig) noexcept {
    // Let the parent decode everything first
    if (auto ccode = Parent::setConfig(jobConfig, taskConfig, serviceConfig))
        return ccode;

    // Then parse the bucket out
    if (auto ccode = BlobConfig::__fromJson(config, m_blobConfig)) return ccode;
    return {};
}

//-----------------------------------------------------------------
/// Update client and return path info
//-----------------------------------------------------------------
ErrorOr<Path> IFilterEndpoint::processPath(
    PATH_PROCESSING_TYPE type, const Path &path,
    std::shared_ptr<Azure::Storage::Blobs::BlobContainerClient>
        &blobContainerClient) noexcept {
    // Format is: /<account name>/<container name>/path
    if (type == PATH_PROCESSING_TYPE::ACCOUNT_AND_CONTAINER &&
        path.count() <
            _cast<size_t>(PATH_PROCESSING_TYPE::ACCOUNT_AND_CONTAINER)) {
        MONERR(error, Ec::InvalidParam,
               "Expecting Azure account name and container name in the path");
        return APERR(
            Ec::InvalidParam,
            "Expecting Azure account name and container name in the path");
    }
    // Format is: /<container name>/path
    if (type == PATH_PROCESSING_TYPE::CONTAINER_ONLY &&
        path.count() < _cast<size_t>(PATH_PROCESSING_TYPE::CONTAINER_ONLY)) {
        MONERR(error, Ec::InvalidParam,
               "Expecting Azure container name in the path");
        return APERR(Ec::InvalidParam,
                     "Expecting Azure container name in the path");
    }
    // container is in first/second position, everything else is a path
    auto containerName = path[_cast<uint32_t>(type) - 1];

    Error ccode = callAndCatch(_location, "Processing path", [&]() -> Error {
        LOGT("Checking existence of Azure object '{}'", containerName);

        blobContainerClient.reset(
            new Azure::Storage::Blobs::BlobContainerClient(
                m_client.m_blobServiceClient->GetBlobContainerClient(
                    Text(containerName))));

        return {};
    });

    if (ccode) {
        MONERR(
            error, Ec::InvalidParam,
            "Invalid container name (check Azure credentials):", containerName);
        return APERR(Ec::InvalidParam,
                     "Invalid container name  (check Azure credentials):",
                     containerName);
    }

    return path.subpth(_cast<uint32_t>(type));
}

ErrorOr<const Azure::Storage::Blobs::Models::BlobContainerAccessPolicy>
IFilterEndpoint::getAccessPolicy(Path &path) noexcept {
    std::shared_ptr<Azure::Storage::Blobs::BlobContainerClient>
        blobContainerClient;
    auto errorOr = processPath(PATH_PROCESSING_TYPE::ACCOUNT_AND_CONTAINER,
                               path, blobContainerClient);
    if (errorOr.hasCcode()) return errorOr.ccode();
    Path container = errorOr.value();
    auto permission = m_accessPolicies.find(Text(path.at(1)));
    if (permission != m_accessPolicies.end()) return permission->second;

    auto lock = m_lock.lock();
    permission = m_accessPolicies.find(Text(path.at(1)));
    if (permission != m_accessPolicies.end()) return permission->second;

    Azure::Storage::Blobs::Models::BlobContainerAccessPolicy permsValue;

    Error ccode = callAndCatch(_location, "get AccessPolicy", [&]() -> Error {
        LOGT("Checking Policty of Azure object '{}'", path);

        auto perms = blobContainerClient->GetAccessPolicy();
        permsValue = perms.Value;
        return {};
    });

    if (ccode) {
        MONERR(error, Ec::Error, "Permissions are not found", path);
        return {};
    }
    m_accessPolicies.insert(std::make_pair(Text(path.at(1)), permsValue));
    return permsValue;
}

}  // namespace engine::store::filter::azure