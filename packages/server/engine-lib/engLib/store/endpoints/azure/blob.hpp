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
//	Declares the object for working with Azure blob storage.
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store::filter::azure {
//-------------------------------------------------------------------------
/// @details
///		Declare our factory info
//-------------------------------------------------------------------------
_const auto Type = "azure"_itv;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceAzureBlob;

//-------------------------------------------------------------------------
/// @details
///		Define the Azure path processing type
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(PATH_PROCESSING_TYPE, 0, 3, NONE = _begin, CONTAINER_ONLY,
                   ACCOUNT_AND_CONTAINER);

//-------------------------------------------------------------------------
// Define our configuration info
//-------------------------------------------------------------------------
struct BlobConfig {
    _const auto DefaultEndpointSuffix = "blob.core.windows.net"_tv;

    Text accountName;
    Text accountKey;
    Text endpointSuffix = DefaultEndpointSuffix;
    std::vector<Text> containers;
    bool deleted = false;

    //---------------------------------------------------------------------
    /// @details
    ///		Parse the service information from the given json
    ///	@param[in]	serviceConfig
    ///		json to parse from
    ///	@param[out]	blobConfig
    ///		configuration object to set
    ///	@returns
    //---------------------------------------------------------------------
    static Error __fromJson(IServiceConfig &serviceConfig,
                            BlobConfig &blobConfig) noexcept {
        if (auto ccode = serviceConfig.parameters.lookupAssign(
                             "accountName", blobConfig.accountName) ||
                         serviceConfig.parameters.lookupAssign(
                             "accountKey", blobConfig.accountKey) ||
                         serviceConfig.parameters.lookupAssign(
                             "endpointSuffix", blobConfig.endpointSuffix))
            return ccode;

        if (!blobConfig.accountName)
            return APERR(Ec::InvalidParam, "Missing required account name");
        if (!blobConfig.accountKey)
            return APERR(Ec::InvalidParam, "Missing required account key");

        if (serviceConfig.serviceMode == SERVICE_MODE::SOURCE) {
            for (const auto &include : serviceConfig.serviceConfig["include"]) {
                Text path;
                // Get the include path
                if (auto ccode = include.lookupAssign("path", path))
                    return ccode;
                if (!path.empty()) {
                    Path includePath{path};
                    Path container{includePath[0]};
                    blobConfig.containers.push_back(container.gen());
                }
            }
        } else if (serviceConfig.serviceMode == SERVICE_MODE::TARGET) {
            if (!serviceConfig.storePath.empty()) {
                // path[0] is a container's name
                Path container{serviceConfig.storePath.front()};
                blobConfig.containers.push_back(container.gen());
            }
        }

        auto res =
            serviceConfig.serviceConfig.lookupCheck<bool>("deleted", false);
        if (res.hasCcode()) return res.ccode();
        blobConfig.deleted = res.value();

        if (!blobConfig.deleted && blobConfig.containers.empty())
            return APERR(Ec::InvalidParam, "Missing required container name");

        // Done
        return {};
    }
};

//-------------------------------------------------------------------------
/// @details
///		Defines the blob client used to store connection options
//-------------------------------------------------------------------------
struct BlobClient {
    BlobClient() : m_blobContainerClient() {};
    ~BlobClient() { m_blobContainerClient.reset(); }
    std::shared_ptr<Azure::Storage::Blobs::BlobServiceClient>
        m_blobServiceClient;
    std::shared_ptr<Azure::Storage::Blobs::BlobContainerClient>
        m_blobContainerClient;
    std::shared_ptr<Azure::Storage::Blobs::BlockBlobClient> m_blobBlockClient;
};

class IFilterInstance;

//-------------------------------------------------------------------------
/// @details
///		Define the endpoint
//-------------------------------------------------------------------------
class IFilterEndpoint : public IServiceEndpoint {
public:
    using Config = IServiceConfig;
    using Parent = IServiceEndpoint;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///	    Allow the filter instance to see our private data. We can
    ///	    either make it public, or limit the scope to
    ///	    IFilterInstance
    ///     Generally, access to processPath is needed
    ///
    //-----------------------------------------------------------------
    friend IFilterInstance;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IFilterEndpoint(const FactoryArgs &args) noexcept
        : Parent(args), m_client() {};
    virtual ~IFilterEndpoint() {};

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterEndpoint, Parent>(Type);

    //-----------------------------------------------------------------
    /// Get blob configuration info
    //-----------------------------------------------------------------
    const BlobConfig &getBlobConfig() const noexcept { return m_blobConfig; }
    //-----------------------------------------------------------------
    /// Get client info
    //-----------------------------------------------------------------
    const std::shared_ptr<Azure::Storage::Blobs::BlobServiceClient> getClient()
        const noexcept {
        return m_client.m_blobServiceClient;
    }

    //-----------------------------------------------------------------
    /// Request Policies
    //-----------------------------------------------------------------
    ErrorOr<const Azure::Storage::Blobs::Models::BlobContainerAccessPolicy>
    getAccessPolicy(Path &path) noexcept;

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginEndpoint(OPEN_MODE openMode) noexcept override;
    virtual Error getConfigSubKey(Text &key) noexcept override;
    virtual Error validateConfig(bool syntaxOnly) noexcept override;
    virtual Error setConfig(const json::Value &jobConfig,
                            const json::Value &taskConfig,
                            const json::Value &serviceConfig) noexcept override;
    virtual Error scanObjects(Path &path,
                              const ScanAddObject &callback) noexcept override;

private:
    inline void setupSslOptions() noexcept(false);

    //-----------------------------------------------------------------
    /// Update client and return path info
    //-----------------------------------------------------------------
    ErrorOr<Path> processPath(
        PATH_PROCESSING_TYPE type, const Path &path,
        std::shared_ptr<Azure::Storage::Blobs::BlobContainerClient>
            &blobContainerClient) noexcept;

    //-----------------------------------------------------------------
    /// Process specific entry object
    //-----------------------------------------------------------------
    Error processEntry(const Azure::Storage::Blobs::Models::BlobItem &blob,
                       Entry &object, const ScanAddObject &addObject) noexcept;
    Error processContainers(const ScanAddObject &addObject) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Parsed configuration
    //-----------------------------------------------------------------
    BlobConfig m_blobConfig;
    BlobClient m_client;
    mutable async::MutexLock m_lock;
    std::unordered_map<Text,
                       Azure::Storage::Blobs::Models::BlobContainerAccessPolicy>
        m_accessPolicies;
};

//-------------------------------------------------------------------------
/// @details
///		Define the common class for this filter
//-------------------------------------------------------------------------
class IFilterGlobal : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		Allow the filter instance to see our private data. We can
    ///		either make it public, or limit the scope to
    ///		IFilterInstance
    //-----------------------------------------------------------------
    friend IFilterInstance;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterGlobal, Parent>(Type);
};

//-------------------------------------------------------------------------
/// @details
///		Define the instance class for this filter
//-------------------------------------------------------------------------
class IFilterInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IFilterInstance(const FactoryArgs &args) noexcept
        : Parent(args),
          endpoint((static_cast<IFilterEndpoint &>(*args.endpoint))),
          global((static_cast<IFilterGlobal &>(*args.global))) {};
    virtual ~IFilterInstance() {};

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterInstance, Parent>(Type);

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginFilterInstance() noexcept override;
    virtual Error renderObject(ServicePipe &target,
                               Entry &object) noexcept override;
    virtual Error removeObject(Entry &object) noexcept override;
    virtual Error checkChanged(Entry &object) noexcept override;
    virtual ErrorOr<bool> stat(Entry &object) noexcept override;

    virtual Error getPermissions(Entry &entry) noexcept override;
    virtual ErrorOr<std::list<Text>> outputPermissions() noexcept override;
    Error mapId(TextView idStr, std::unordered_set<Text> &mappedIds) noexcept;

    bool hasAllRights(const std::string &permission) noexcept {
        if (permission.empty()) return false;

        return permission.find('r') != string::npos &&  // read
               permission.find('w') != string::npos &&  // write
               permission.find('a') != string::npos &&  // add
               permission.find('c') != string::npos &&  // create
               permission.find('d') != string::npos &&  // delete
               permission.find('l') != string::npos;    // list
    }

    ErrorOr<engine::perms::Rights> getRights(
        const std::string &permission) noexcept {
        using namespace engine::perms;
        if (permission.empty())
            return APERR(Ec::NoPermissions, "Permissions are not set");

        Rights rights;
        bool hasRead = permission.find('r') != string::npos;
        bool hasWrite = permission.find('w') != string::npos;
        if (hasRead && hasWrite) {
            rights.canRead = true;
            rights.canWrite = true;
        } else if (hasRead) {
            rights.canRead = true;
        } else if (hasWrite) {
            rights.canWrite = true;
        }

        return rights;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Public functions used for store
    //-----------------------------------------------------------------
    virtual Error open(Entry &entry) noexcept override;
    virtual Error writeTag(const TAG *pTag) noexcept override;
    virtual Error close() noexcept override;

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		Private functions used for store
    //-----------------------------------------------------------------
    Error processObjectStreamData(const TAG_OBJECT_STREAM_DATA *pTag) noexcept;

    //-----------------------------------------------------------------
    // @details
    //      Implementation function used to render the object
    //-----------------------------------------------------------------
    Error sendTagMetadata(ServicePipe &target, Entry &object) noexcept;
    Error renderStandardFile(ServicePipe &target, Entry &object) noexcept;
    Error sendTagBeginStream(ServicePipe &target, TAG *pTagBuffer,
                             Entry &object) noexcept;
    Error sendTagEndStream(ServicePipe &target) noexcept override;

    //
    Error processMetadata(const TAG_OBJECT_METADATA *pTag) noexcept;
    Error setMetadata() noexcept;
    Error isObjectUpdateNeeded() noexcept;

    //-----------------------------------------------------------------
    // @details
    //      Update client and extract path
    //-----------------------------------------------------------------
    ErrorOr<Path> processPath(
        const Entry &object,
        std::shared_ptr<Azure::Storage::Blobs::BlobContainerClient>
            &blobContainerClient) noexcept {
        Path path;
        if (auto ccode = Url::toPath(object.url(), path)) return ccode;
        return endpoint.processPath(PATH_PROCESSING_TYPE::ACCOUNT_AND_CONTAINER,
                                    path, blobContainerClient);
    }

private:
    //-----------------------------------------------------------------
    // Reference to the bound pipe
    //-----------------------------------------------------------------
    IFilterGlobal &global;

    //-----------------------------------------------------------------
    // Reference to the bound pipe
    //-----------------------------------------------------------------
    IFilterEndpoint &endpoint;

    //-----------------------------------------------------------------
    /// @details
    ///     Part data of the current target object to upload.
    //-----------------------------------------------------------------
    memory::Data<Byte> m_targetObjectDataBuffer;
    unsigned int m_offset = 0;
    std::vector<std::string> m_blockIds;
    BlobClient m_client;
    //-----------------------------------------------------------------
    ///	@details
    ///		Size of the single part at multipart upload
    //-----------------------------------------------------------------
    size_t m_azurePartSize = 0;

    //-----------------------------------------------------------------
    ///	@details
    ///		Default size of the single part at multipart upload
    //-----------------------------------------------------------------
    _const auto m_azureDefaultPartSize = 8_mb;

    //-----------------------------------------------------------------
    ///	@details
    ///		Max number of parts at multipart upload
    //-----------------------------------------------------------------
    _const auto m_azureMaxPartNumber = 10000;

    //-----------------------------------------------------------------
    /// @details
    ///     Path to current target object to upload.
    //-----------------------------------------------------------------
    Path m_TargetObjectPath;

    //-----------------------------------------------------------------
    /// @details
    ///     Flag that indicates if metadata should be set at the
    ///     `close` step
    //-----------------------------------------------------------------
    bool m_setMetadata = true;
};

// helper function
time_t convertFromAzureDateTime(const Azure::DateTime &dt) noexcept;
}  // namespace engine::store::filter::azure
