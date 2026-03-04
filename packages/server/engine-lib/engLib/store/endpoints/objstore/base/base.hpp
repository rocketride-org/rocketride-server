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
//  Declares the base object store for working with S3 and compat obj store
//  services.
//
//-----------------------------------------------------------------------------
#pragma once
#include "./headers.h"

namespace engine::store::filter::baseObjectStore {
class IBaseEndpoint;
class IBaseInstance;
class IBaseGlobal;

//-------------------------------------------------------------------------
///  @details
///    The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceObjectStore;

//-------------------------------------------------------------------------
// Define our configuration info - this
// supports all options for all the different obj store derivations
//-------------------------------------------------------------------------
struct AWSConfig {
    Text region;
    Text url;
    Text accessKey;
    Text secretKey;
    std::vector<Text> buckets;
    bool useSSL = true;
    bool deleted = false;
    bool verifySSL = false;

    //---------------------------------------------------------------------
    /// @details
    ///		Parse the service information from the given json
    ///	@param[in]	value
    ///		json to parse from
    ///	@param[out]	config
    ///		Recieves the info
    ///	@returns
    //---------------------------------------------------------------------
    static Error __fromJson(IServiceConfig &serviceConfig,
                            AWSConfig &awsConfig) noexcept {
        if (auto ccode =
                serviceConfig.parameters.lookupAssign("accessKey",
                                                      awsConfig.accessKey) ||
                serviceConfig.parameters.lookupAssign("secretKey",
                                                      awsConfig.secretKey) ||
                serviceConfig.parameters.lookupAssign("region",
                                                      awsConfig.region) ||
                serviceConfig.parameters.lookupAssign("url", awsConfig.url) ||
                serviceConfig.parameters.lookupAssign<bool>("useSSL",
                                                            awsConfig.useSSL))
            return ccode;

        if (!awsConfig.accessKey)
            return APERR(Ec::InvalidParam, "Missing required access key");
        if (!awsConfig.secretKey)
            return APERR(Ec::InvalidParam, "Missing required secret key");

        if (serviceConfig.serviceMode == SERVICE_MODE::SOURCE) {
            for (const auto &include : serviceConfig.serviceConfig["include"]) {
                Text path;
                // Get the include path
                if (auto ccode = include.lookupAssign("path", path))
                    return ccode;
                Path includePath{path};
                Path bucket{includePath[0]};
                awsConfig.buckets.push_back(bucket.gen());
            }
        } else {
            if (serviceConfig.storePath.empty())
                return APERR(Ec::InvalidParam, "Missing required store path");

            // path[0] is a bucket's name
            Path bucket{serviceConfig.storePath[0]};
            awsConfig.buckets.push_back(bucket.gen());
        }

        auto res =
            serviceConfig.serviceConfig.lookupCheck<bool>("deleted", false);
        if (res.hasCcode()) return res.ccode();
        awsConfig.deleted = res.value();

        if (!awsConfig.deleted && awsConfig.buckets.empty())
            return APERR(Ec::InvalidParam, "Missing required bucket name");

        // Done
        return {};
    }
};

//-------------------------------------------------------------------------
// Handles converting AWS errors to our errors
//-------------------------------------------------------------------------
template <typename Type>
inline Error errorFromS3Error(std::shared_ptr<Aws::S3::S3Client> &client,
                              Location loc,
                              const Aws::Client::AWSError<Type> &e,
                              const Text bucketName = Text()) noexcept {
    // On error clear the client so we create a new one next time
    client.reset();

    Ec errorCode = Ec::RequestFailed;
    Text msg;

    // See https://docs.aws.amazon.com/AmazonS3/latest/API/ErrorResponses.html
    if (auto &exceptionName = e.GetExceptionName(); !exceptionName.empty()) {
        // Get the exception code
        msg = exceptionName;

        // If it is invalid range, change the error code
        if (exceptionName == "InvalidRange") errorCode = Ec::OutOfRange;

        if (exceptionName == "PermanentRedirect") {
            errorCode = Ec::RequestFailed;
        }

        // If it is a sig problem, it is probably an issue with the secret key
        if (exceptionName == "SignatureDoesNotMatch") msg = "InvalidSecretKey";
    }

    // Add the message text
    if (e.GetExceptionName() == "PermanentRedirect") {
        msg = _fmt("Scanning path failed {}", bucketName);
    } else if (auto &message = e.GetMessage(); !message.empty()) {
        msg += _ts(": ", message);
    }

    // Create the error
    return APERRLL(ServiceObjectStore, errorCode, _location, _mv(msg));
}

template <typename Type>
inline Error monitorS3Warning(std::shared_ptr<Aws::S3::S3Client> &client,
                              Location loc,
                              const Aws::Client::AWSError<Type> &e) noexcept {
    Error ccode = errorFromS3Error(client, loc, e);

    MONERR(warning, ccode.code(), ccode.message());
    return ccode;
}

//-------------------------------------------------------------------------
// Declare the AWS options
//-------------------------------------------------------------------------
inline Aws::SDKOptions &AwsOptions() noexcept {
    static Aws::SDKOptions options;
    return options;
}

//-------------------------------------------------------------------------
// Global AWS init - done in store::init
//-------------------------------------------------------------------------
inline auto init() noexcept {
    Aws::InitAPI(AwsOptions());
    if (log::isLevelEnabled(Lvl::ServiceObjectStoreDetails)) {
        Aws::Utils::Logging::InitializeAWSLogging(
            Aws::MakeShared<Aws::Utils::Logging::DefaultLogSystem>(
                "ObjectStoreLogging", Aws::Utils::Logging::LogLevel::Trace,
                Aws::String((config::paths().log.parent() / "aws_").str())));
    }
}

//-------------------------------------------------------------------------
// Global AWS deinit - done in store::deinit
//-------------------------------------------------------------------------
inline auto deinit() noexcept {
    if (log::isLevelEnabled(Lvl::ServiceObjectStoreDetails))
        Aws::Utils::Logging::ShutdownAWSLogging();
    Aws::ShutdownAPI(AwsOptions());
}

//-------------------------------------------------------------------------
///  @details
///    Define the endpoint
//-------------------------------------------------------------------------
class IBaseEndpoint : public IServiceEndpoint {
public:
    using Config = IServiceConfig;
    using Parent = IServiceEndpoint;
    using Parent::Parent;
    using S3Object = Aws::S3::Model::Object;

    //-----------------------------------------------------------------
    ///  @details
    ///    Allow the filter instance to see our private data. We can
    ///    either make it public, or limit the scope to
    ///    IBaseInstance
    //-----------------------------------------------------------------
    friend IBaseInstance;

    //-----------------------------------------------------------------
    ///  @details
    ///    The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IBaseEndpoint(const FactoryArgs &args, const TextView type) noexcept
        : Parent(args), m_type(type) {};
    virtual ~IBaseEndpoint() {};

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
    virtual Error processEntry(const S3Object &s3Object, Entry &object,
                               const ScanAddObject &addObject,
                               const SharedPtr<Aws::S3::S3Client> &client,
                               const Text &bucket) noexcept;
    virtual Error processBuckets(const SharedPtr<Aws::S3::S3Client> &client,
                                 const ScanAddObject &callback) noexcept;

    void extractBucketAndKeyFromPath(TextView path, Text &bucket,
                                     Text &prefixOrKey) noexcept;
    template <class S3Request>
    S3Request makeRequest(TextView path) noexcept;
    template <class S3Request>
    S3Request makeRequest(const Url &url) noexcept;

    //-----------------------------------------------------------------
    ///  @details
    ///    Parsed configuration containing bucket, access keys, etc
    //-----------------------------------------------------------------
    AWSConfig m_storeConfig;

    //-----------------------------------------------------------------
    ///  @details
    ///    Type (protocol) set during construction
    //-----------------------------------------------------------------
    Text m_type;

protected:
    Text getContentType(const Text &key,
                        const SharedPtr<Aws::S3::S3Client> &client,
                        const Text &bucket) noexcept;
};

//-------------------------------------------------------------------------
/// @details
///        Define the common class for this filter
//-------------------------------------------------------------------------
class IBaseGlobal : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///  @details
    ///    Allow the filter instance to see our private data. We can
    ///    either make it public, or limit the scope to
    ///    IBaseInstance
    //-----------------------------------------------------------------
    friend IBaseInstance;

    //-----------------------------------------------------------------
    ///  @details
    ///    The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;
};

//-------------------------------------------------------------------------
///  @details
///    Define the instance class for this filter
//-------------------------------------------------------------------------
class IBaseInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;

    //-----------------------------------------------------------------
    ///  @details
    ///    The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IBaseInstance(const FactoryArgs &args) noexcept
        : Parent(args),
          endpoint((static_cast<IBaseEndpoint &>(*args.endpoint))),
          global((static_cast<IBaseGlobal &>(*args.global))) {};
    virtual ~IBaseInstance() {};

    //-----------------------------------------------------------------
    ///	@details
    ///		Marker for AWS related memory allocations
    //-----------------------------------------------------------------
    _const auto AllocTag = "ObjectStoreClient";

    //-----------------------------------------------------------------
    ///  @details
    ///    Number of ThreadTasks used to download the data from S3.
    //-----------------------------------------------------------------
    _const auto AwsThreadExecutorPoolSize = 25;

    //-----------------------------------------------------------------
    ///	@details
    ///		Default size of the single part at multipart upload
    //-----------------------------------------------------------------
    _const auto AwsDefaultPartSize = 8_mb;

    //-----------------------------------------------------------------
    ///	@details
    ///		Max number of parts at multipart upload
    //-----------------------------------------------------------------
    _const auto AwsMaxPartNumber = 10000;

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginFilterInstance() noexcept override;
    virtual Error removeObject(Entry &entry) noexcept override;
    virtual Error renderObject(ServicePipe &target,
                               Entry &object) noexcept override;
    virtual Error checkChanged(Entry &object) noexcept override;
    virtual Error getPermissions(Entry &entry) noexcept override;
    virtual ErrorOr<std::list<Text>> outputPermissions() noexcept override;

    ErrorOr<engine::perms::Rights> getRights(
        const Aws::S3::Model::Permission &permission) noexcept;
    Error mapId(TextView idStr, std::unordered_set<Text> &mappedIds) noexcept;

    Error ensureClient() noexcept;
    ErrorOr<bool> stat(Entry &entry) noexcept override;

    //-----------------------------------------------------------------
    /// @details
    ///		Public functions used for store
    //-----------------------------------------------------------------
    virtual Error open(Entry &entry) noexcept override;
    virtual Error writeTag(const TAG *pTag) noexcept override;
    virtual Error close() noexcept override;

    //-----------------------------------------------------------------
    ///  @details
    ///    Allocate and get a new AWS client
    //-----------------------------------------------------------------
    static ErrorOr<SharedPtr<Aws::S3::S3Client>> newClient(
        const Aws::Client::ClientConfiguration &conf,
        const Aws::Auth::AWSCredentials &creds);
    static ErrorOr<SharedPtr<Aws::S3::S3Client>> getClient(AWSConfig &config);

    //-----------------------------------------------------------------
    ///  @details
    ///    Get bucket names from an AWS client
    //-----------------------------------------------------------------
    static ErrorOr<std::vector<Text>> getBuckets(
        const SharedPtr<Aws::S3::S3Client> &client) noexcept;

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		Private functions used for store
    //-----------------------------------------------------------------
    Error processObjectStreamData(const TAG_OBJECT_STREAM_DATA *pTag) noexcept;
    Error uploadTargetObjectPart(bool latestPart) noexcept;

    //-----------------------------------------------------------------
    ///  @details
    ///    Private functions used to render the object
    //-----------------------------------------------------------------
    Error sendTagMetadata(ServicePipe &target,
                          TAG_OBJECT_METADATA::FLAGS metadataFlags,
                          Entry &object) noexcept;
    Error renderStandardFile(ServicePipe &target, Entry &object) noexcept;
    Error sendTagBeginStream(Aws::IOStream &fileStream, ServicePipe &target,
                             TAG *pTagBuffer, Entry &object) noexcept;
    Error sendTagEndStream(ServicePipe &target) noexcept override;
    Error sendTagMetadata(ServicePipe &target, Entry &object) noexcept;

    //
    Error setMetadata() noexcept;
    Error isObjectUpdateNeeded() noexcept;

private:
    //-----------------------------------------------------------------
    // Reference to the bound pipe
    //-----------------------------------------------------------------
    IBaseGlobal &global;

    //-----------------------------------------------------------------
    // Reference to the bound pipe
    //-----------------------------------------------------------------
    IBaseEndpoint &endpoint;

    //-----------------------------------------------------------------
    /// @details
    ///     client, gets reset on error for re-connect
    //-----------------------------------------------------------------
    std::shared_ptr<Aws::S3::S3Client> m_streamClient;

    //-----------------------------------------------------------------
    /// @details
    ///     S3 upload id of the current target object
    //-----------------------------------------------------------------
    Text m_targetObjectUploadId;

    //-----------------------------------------------------------------
    /// @details
    ///     Part data of the current target object to upload.
    //-----------------------------------------------------------------
    memory::Data<Byte> m_targetObjectDataBuffer;

    //-----------------------------------------------------------------
    /// @details
    ///     Uploaded size of the current target object.
    //-----------------------------------------------------------------
    size_t m_targetObjectUploadSize = 0;

    //-----------------------------------------------------------------
    /// @details
    ///     Size of part of the current target object to upload.
    //-----------------------------------------------------------------
    size_t m_targetObjectUploadPartSize = 0;

    //-----------------------------------------------------------------
    /// @details
    ///     Collection of uploaded parts to complete upload.
    //-----------------------------------------------------------------
    Aws::S3::Model::CompletedMultipartUpload
        m_targetObjectCompletedMultipartUpload;

    //-----------------------------------------------------------------
    /// @details
    ///     Flag that indicates if the object should be updated
    //-----------------------------------------------------------------
    Error m_updateObject = {};

    struct ObjectGrants {
        Text granteeName;
        Aws::S3::Model::Type granteeType = Aws::S3::Model::Type::NOT_SET;
    };

    std::unordered_map<Text, struct ObjectGrants> m_granteesById;

    mutable async::MutexLock m_lock;
};

}  // namespace engine::store::filter::baseObjectStore
