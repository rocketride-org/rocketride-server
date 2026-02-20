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
//  Defines the segmented read/write functions. These are for getting
//  and putting data into the IO buffer on segmented files in the rocketride
//  format.
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::baseObjectStore {
//---------------------------------------------------------------------
/// @details
///        get Content-Type
///    @param[in]    key
///        S3 object's key (name)
///    @returns
///        Text
//---------------------------------------------------------------------
Text IBaseEndpoint::getContentType(const Text &key,
                                   const SharedPtr<Aws::S3::S3Client> &client,
                                   const Text &bucket) noexcept {
    // Define the request to read the file
    const auto objectsReq =
        Aws::S3::Model::HeadObjectRequest().WithBucket(bucket).WithKey(key);

    // get the object from the bucket
    auto objectsResp = client->HeadObject(objectsReq);
    if (objectsResp.IsSuccess())
        return objectsResp.GetResultWithOwnership().GetContentType();

    return {};
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
                                  const ScanAddObject &addObject,
                                  const SharedPtr<Aws::S3::S3Client> &client,
                                  const Text &bucket) noexcept {
    Error ccode;
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

    key = "Content-Type";
    param = getContentType(s3Object.GetKey(), client, bucket);
    metadata[key] = param;

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
    static auto start = time::now();
    Text delimiter = "/";
    Text tempPath = path.gen() + delimiter;
    Error ccode;

    // Get a new aws client
    auto client = IBaseInstance::getClient(m_storeConfig);
    if (!client) return client.ccode();

    if (tempPath == delimiter) {
        if (ccode = processBuckets(client.value(), callback)) return ccode;
        return {};
    }

    Text bucket, prefix;
    extractBucketAndKeyFromPath(tempPath, bucket, prefix);

    static uint64_t count = 0;
    Aws::String lastObjectInChunk;
    Aws::Vector<Aws::S3::Model::CommonPrefix> prevPrefixes;
    Aws::Vector<Aws::S3::Model::Object> prevObjects;

    _forever() {
        // Define the request to list the segments. Default max keys to retrieve
        // is 1000
        auto listObjectsReq = Aws::S3::Model::ListObjectsV2Request()
                                  .WithBucket(bucket)
                                  .WithStartAfter(lastObjectInChunk)
                                  .WithPrefix(prefix)
                                  .WithDelimiter(delimiter);

        // Just list all segments in the bucket
        auto listObjectsResp = client->ListObjectsV2(listObjectsReq);
        if (!listObjectsResp.IsSuccess())
            return errorFromS3Error(*client, _location,
                                    listObjectsResp.GetError(), bucket);

        auto objects = listObjectsResp.GetResult().GetContents();
        auto prefixes =
            listObjectsResp.GetResultWithOwnership().GetCommonPrefixes();

        LOGT("{} segment{} listed", objects.size(),
             objects.size() != 1 ? "s" : "");

        if (objects.empty() && prefixes.empty()) {
            if (!prefix.empty() && prefix.starts_with(delimiter.c_str())) {
                prefix.erase(0, 1);
                continue;
            }

            break;
        }

        if (!prevPrefixes.empty() && prefixes.size() == prevPrefixes.size() &&
            std::equal(prefixes.begin(), prefixes.end(), prevPrefixes.begin(),
                       [](const Aws::S3::Model::CommonPrefix &lhs,
                          const Aws::S3::Model::CommonPrefix &rhs) {
                           return lhs.GetPrefix() == rhs.GetPrefix();
                       }))
            break;

        for (const auto &prefix : prefixes) {
            Entry folderObject;
            Path prefixPath{prefix.GetPrefix()};
            folderObject.name(prefixPath.back());
            folderObject.isContainer(true);
            if (ccode = callback(folderObject)) {
                MONERR(error, ccode, "Scanning on", prefix.GetPrefix(),
                       "failed");
                folderObject.completionCode(ccode);
            }
            lastObjectInChunk = prefix.GetPrefix();
        }
        prevPrefixes = _mv(prefixes);

        if (!prevObjects.empty() && objects.size() == prevObjects.size() &&
            std::equal(objects.begin(), objects.end(), prevObjects.begin(),
                       [](const Aws::S3::Model::Object &lhs,
                          const Aws::S3::Model::Object &rhs) {
                           return lhs.GetKey() == rhs.GetKey();
                       }))
            break;

        for (const auto &s3Object : objects) {
            // if it's a folder -> don't process it
            if (s3Object.GetKey().ends_with(delimiter.c_str())) continue;
            lastObjectInChunk = s3Object.GetKey();
            Entry fileObject;
            if (ccode = processEntry(s3Object, fileObject, callback,
                                     client.value(), bucket)) {
                MONERR(error, ccode, "Scanning on", s3Object.GetKey(),
                       "failed");
                fileObject.completionCode(ccode);
            }
            ++count;
        }
        prevObjects = _mv(objects);
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