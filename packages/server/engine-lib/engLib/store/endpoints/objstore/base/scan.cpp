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
//  Defines the segmented read/write functions. These are for getting
//  and putting data into the IO buffer on segmented files in the rocketride
//  format.
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::baseObjectStore {
//---------------------------------------------------------------------
/// @details
///        Get the cached scan client, creating it on first use. The
///        client is shared by all scanner threads; the AWS client is
///        thread safe.
///    @returns
///        Error or shared_ptr to the client
//---------------------------------------------------------------------
ErrorOr<SharedPtr<Aws::S3::S3Client>> IBaseEndpoint::getScanClient() noexcept {
    auto guard = m_scanClientLock.acquire();
    if (!m_scanClient) {
        auto client = IBaseInstance::getClient(m_storeConfig);
        if (!client) return client.ccode();
        m_scanClient = _mv(*client);
    }
    return m_scanClient;
}
//---------------------------------------------------------------------
/// @details
///        Drop the cached scan client so the next scan re-connects
//---------------------------------------------------------------------
void IBaseEndpoint::resetScanClient() noexcept {
    auto guard = m_scanClientLock.acquire();
    m_scanClient.reset();
}
//---------------------------------------------------------------------
/// @details
///        Processes an entry
///    @param[in]    s3Object
///        The original S3 object
///    @param[out]    object
///        Receives the signalled object
///    @param[in]    addObject
///        The function to add the object
///    @returns
///        Error
//---------------------------------------------------------------------
Error IBaseEndpoint::processEntry(const S3Object &s3Object, Entry &object,
                                  const ScanAddObject &addObject) noexcept {
    json::Value metadata;
    Text key, param;

    // Set the standard stuff
    object.reset();
    object.isContainer(false);
    object.createTime(0);
    object.accessTime(0);

    if (s3Object.SizeHasBeenSet()) {
        object.size((Qword)s3Object.GetSize());
        object.storeSize((Qword)s3Object.GetSize());
    }

    if (s3Object.LastModifiedHasBeenSet()) {
        object.modifyTime(
            time::toTimeT(s3Object.GetLastModified().UnderlyingTimestamp()));
        object.createTime(
            time::toTimeT(s3Object.GetLastModified().UnderlyingTimestamp()));
    }

    if (s3Object.KeyHasBeenSet()) {
        Path path{s3Object.GetKey()};
        object.name(path.fileName());
    }

    if (s3Object.ETagHasBeenSet()) {
        Text objectId = s3Object.GetETag();
        objectId.trim({'\"'});
        object.objectId(objectId);
    }

    if (s3Object.OwnerHasBeenSet()) {
        if (s3Object.GetOwner().IDHasBeenSet()) {
            key = "OWNER_ID";
            param = s3Object.GetOwner().GetID();
            metadata[key] = param;
        }

        if (s3Object.GetOwner().DisplayNameHasBeenSet()) {
            key = "OWNER_NAME";
            param = s3Object.GetOwner().GetDisplayName();
            metadata[key] = param;
        }
    }

    if (!metadata.empty()) object.metadata(_mv(metadata));

    // Add the object
    return addObject(object);
}
//-----------------------------------------------------------------
/// @details
///    Perform a scan for objects Call the callback with each
///    object found.
///    @param[in]    callback
///        Pass a Entry with all the information filled
//-----------------------------------------------------------------
Error IBaseEndpoint::scanObjects(Path &path,
                                 const ScanAddObject &callback) noexcept {
    const auto start = time::now();
    Text delimiter = "/";
    Text tempPath = path.gen() + delimiter;
    Error ccode;

    // Get the cached aws client shared by the scanner threads
    auto clientOr = getScanClient();
    if (!clientOr) return clientOr.ccode();
    auto client = _mv(*clientOr);

    if (tempPath == delimiter) {
        if (ccode = processBuckets(client, callback)) return ccode;
        return {};
    }

    Text bucket, prefix;
    extractBucketAndKeyFromPath(tempPath, bucket, prefix);

    uint64_t count = 0;
    Aws::String continuationToken;

    _forever() {
        // Define the request to list one page of objects. Default max keys to
        // retrieve is 1000. FetchOwner is needed for the owner info below
        auto listObjectsReq = Aws::S3::Model::ListObjectsV2Request()
                                  .WithBucket(bucket)
                                  .WithPrefix(prefix)
                                  .WithDelimiter(delimiter)
                                  .WithFetchOwner(true);
        if (!continuationToken.empty())
            listObjectsReq.SetContinuationToken(continuationToken);

        // Just list all segments in the bucket
        auto listObjectsResp = client->ListObjectsV2(listObjectsReq);
        if (!listObjectsResp.IsSuccess()) {
            resetScanClient();
            return errorFromS3Error(client, _location,
                                    listObjectsResp.GetError(), bucket);
        }

        auto result = listObjectsResp.GetResultWithOwnership();
        const auto &objects = result.GetContents();
        const auto &prefixes = result.GetCommonPrefixes();

        LOGT("{} segment{} listed", objects.size(),
             objects.size() != 1 ? "s" : "");

        if (objects.empty() && prefixes.empty() && continuationToken.empty()) {
            if (!prefix.empty() && prefix.starts_with(delimiter.c_str())) {
                prefix.erase(0, 1);
                continue;
            }

            break;
        }

        for (const auto &commonPrefix : prefixes) {
            Entry folderObject;
            Path prefixPath{commonPrefix.GetPrefix()};
            folderObject.name(prefixPath.back());
            folderObject.isContainer(true);
            if (ccode = callback(folderObject)) {
                MONERR(error, ccode, "Scanning on", commonPrefix.GetPrefix(),
                       "failed");
                folderObject.completionCode(ccode);
            }
        }

        for (const auto &s3Object : objects) {
            // if it's a folder -> don't process it
            if (s3Object.GetKey().ends_with(delimiter.c_str())) continue;
            Entry fileObject;
            if (ccode = processEntry(s3Object, fileObject, callback)) {
                MONERR(error, ccode, "Scanning on", s3Object.GetKey(),
                       "failed");
                fileObject.completionCode(ccode);
            }
            ++count;
        }

        if (!result.GetIsTruncated()) break;
        continuationToken = result.GetNextContinuationToken();
    }

    LOGT("Scan elapsed {}, completed {} objects", time::now() - start, count);

    return {};
}
//-----------------------------------------------------------------
/// @details
///    Perform a scan for buckets. Call the callback with each found bucket.
///     @param[in]    client
///        A pointer to S3 client
///    @param[in]    callback
///        Pass a Entry with all the information filled
///    @returns
///        Error
//-----------------------------------------------------------------
Error IBaseEndpoint::processBuckets(const SharedPtr<Aws::S3::S3Client> &client,
                                    const ScanAddObject &callback) noexcept {
    // request and return buckets
    auto s3Buckets = IBaseInstance::getBuckets(client);
    if (!s3Buckets) return s3Buckets.ccode();

    for (const auto &bucket : s3Buckets.value()) {
        Entry bucketObject;
        bucketObject.name(bucket);
        bucketObject.isContainer(true);
        if (auto ccode = callback(bucketObject)) {
            MONERR(error, ccode, "Scanning on", bucket, "failed");
            bucketObject.completionCode(ccode);
        }
    }

    return {};
}
}  // namespace engine::store::filter::baseObjectStore