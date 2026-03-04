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
//	Declares the base object store for working with S3 and compat obj store
//	services.
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::baseObjectStore {
//-----------------------------------------------------------------
/// @details
///     Allocate a new AWS client
/// @param[in]  config
///     Configuration of the AWS client
/// @param[in]  creds
///     Credentials used for the connection of the client
/// @returns
///     Error or shared_ptr to a new client
//-----------------------------------------------------------------
ErrorOr<SharedPtr<Aws::S3::S3Client>> IBaseInstance::newClient(
    const Aws::Client::ClientConfiguration &conf,
    const Aws::Auth::AWSCredentials &creds) {
    return _call([&] {
        return Aws::MakeShared<Aws::S3::S3Client>(
            AllocTag, creds, conf,
            Aws::Client::AWSAuthV4Signer::PayloadSigningPolicy::Never, false);
    });
}

//-----------------------------------------------------------------
/// @details
///		This function will take the service config and return a new
///		aws client connection from it
///	@param[in]	mode
///		Mode that endpoint is opened in
///	@returns
///		Error
//-----------------------------------------------------------------
ErrorOr<SharedPtr<Aws::S3::S3Client>> IBaseInstance::getClient(
    AWSConfig &config) {
    // This is really ugly, but we have to set the default region so
    // ClientConfiguration doesn't call AWS to get it from the account
    // Problem is that our ap::plat::setEnv uses the Windows
    // SetEnvironmentVariable whereas the AWSSDK use getenv. These two cannot be
    // mixed. If we used ap::plat::setEnv, the AWSSDK would not see the variable
    // #if ROCKETRIDE_PLAT_WIN
    //         _putenv("AWS_REGION=us-east-1");
    // #else
    //         ::setenv("AWS_REGION", "us-east-1", true);
    // #endif

    Aws::Auth::AWSCredentials creds;
    creds.SetAWSAccessKeyId(config.accessKey);
    creds.SetAWSSecretKey(config.secretKey);

    Aws::Client::ClientConfiguration clientCfg;
    clientCfg.connectTimeoutMs = 30'000;
    clientCfg.requestTimeoutMs = 120'000;

    if (!config.region)
        config.region = string::lowerCase(Aws::Region::US_EAST_1);
    clientCfg.region = config.region;

    if (config.url) clientCfg.endpointOverride = config.url;

    clientCfg.verifySSL = config.verifySSL;

    if (config.useSSL)
        clientCfg.scheme = Aws::Http::Scheme::HTTPS;
    else
        clientCfg.scheme = Aws::Http::Scheme::HTTP;

    return newClient(clientCfg, creds);
}
//-----------------------------------------------------------------
/// @details
///		This function will take the service client and return a vector
///		of buckets
///	@param[in]	client
///		The client of a S3 source/target
///	@returns
///		Error or list of buckets
//-----------------------------------------------------------------
ErrorOr<std::vector<Text>> IBaseInstance::getBuckets(
    const SharedPtr<Aws::S3::S3Client> &client) noexcept {
    std::vector<Text> result;
    auto outcome = client->ListBuckets();

    if (outcome.IsSuccess() && outcome.GetResult().GetBuckets().size() > 0) {
        result.reserve(outcome.GetResult().GetBuckets().size());
        for (const auto &b : outcome.GetResult().GetBuckets())
            result.push_back(b.GetName());
    } else {
        return APERR(Ec::NotFound, outcome.GetError());
    }

    return result;
}

//-------------------------------------------------------------------------
/// @details
///		Begins operations on this filter. Sets up commonly used members
///	@param[in]	mode
///		Mode that endpoint is opened in
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IBaseInstance::beginFilterInstance() noexcept {
    if (auto ccode = ensureClient()) return ccode;
    return Parent::beginFilterInstance();
}

//-------------------------------------------------------------------------
/// @details
///		Get AWS S3 client
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IBaseInstance::ensureClient() noexcept {
    if (m_streamClient) return {};

    auto clientOr = getClient(endpoint.m_storeConfig);
    if (!clientOr) return clientOr.ccode();

    m_streamClient = _mv(*clientOr);

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Begins operations on this filter. Sets up commonly used members
///	@param[in]	openMode
///		Mode that endpoint is opened in
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IBaseEndpoint::beginEndpoint(OPEN_MODE openMode_) noexcept {
    return Parent::beginEndpoint(openMode_);
}

//-----------------------------------------------------------------
/// @details
///		Make static, finalized configs
//-----------------------------------------------------------------
Error IBaseEndpoint::getConfigSubKey(Text &key) noexcept {
    if (config.serviceMode == SERVICE_MODE::SOURCE) {
        key = _ts(m_storeConfig.url, "/", m_storeConfig.accessKey);
    } else {
        key = _ts(m_storeConfig.url, "/", m_storeConfig.accessKey, "/",
                  config.storePath);
    }
    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function is called as one of the last steps in
///     construction of the endpoint. We will use it to parse
///     the aws information
///	@param[in]	jobConfig
///		The full job config
///	@param[in]	taskConfig
///		The task info
///	@param[in]	serviceConfig
///		The service config
///	@returns
///		Error
//-----------------------------------------------------------------
Error IBaseEndpoint::setConfig(const json::Value &jobConfig,
                               const json::Value &taskConfig,
                               const json::Value &serviceConfig) noexcept {
    // Let the parent decode everything first
    if (auto ccode = Parent::setConfig(jobConfig, taskConfig, serviceConfig))
        return ccode;

    // Then parse the bucket out
    if (auto ccode = AWSConfig::__fromJson(config, m_storeConfig)) return ccode;
    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function will take a path and a service type (aws/objstore) and
///     split it to a bucket name and the rest
///	@param[in]	path
///		original path
/// @param[out]	bucket
///		extracted bucket name
/// @param[out]	prefixOrKey
///		extracted prefix (full folder name) or key (full file name)
///	@returns
///		void
//-----------------------------------------------------------------
void IBaseEndpoint::extractBucketAndKeyFromPath(TextView path, Text &bucket,
                                                Text &prefixOrKey) noexcept {
    _const auto delimiter = "/"_tv;

    prefixOrKey = path;
    Path fullPath{path};
    // fullPath[0] is a bucket's name
    Path bucketPath{fullPath[0]};
    bucket = bucketPath.gen();
    prefixOrKey.erase(0, bucketPath.length());
    if (m_type == s3::Type && prefixOrKey.startsWith(delimiter))
        prefixOrKey.erase(0, 1);
}

//-----------------------------------------------------------------
/// @details
///		Creates AWS S3 request structure and fills the bucket name
/// 	and AWS object path which are extracted from passed RocketRide
/// 	object path
///	@param[in]	path
///		original path
template <class S3Request>
S3Request IBaseEndpoint::makeRequest(TextView path) noexcept {
    Text bucket, key;
    extractBucketAndKeyFromPath(path, bucket, key);

    return S3Request().WithKey(key).WithBucket(bucket);
}

//-----------------------------------------------------------------
/// @details
///		Creates AWS S3 request structure and fills the bucket name
/// 	and AWS object path which are extracted from passed RocketRide
/// 	object url
///	@param[in]	url
///		original url
template <class S3Request>
S3Request IBaseEndpoint::makeRequest(const Url &url) noexcept {
    Text path;
    if (auto ccode = Url::toPath(url, path)) {
        LOG(Error, ccode);
        return {};
    }
    return makeRequest<S3Request>(path.toView());
}
}  // namespace engine::store::filter::baseObjectStore