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
//    Defines the segmented read/write functions. These are for getting
//  and putting data into the IO buffer on segmented files in the rocketride
//  format.
//
//-----------------------------------------------------------------------------

namespace engine::store::filter::azure {
inline auto __transform(const StatInfo &prov, file::StatInfo &fs) noexcept {
    fs = _fj<file::StatInfo>(prov.internal);
}

//---------------------------------------------------------------------
/// @details
///        Converts time from Azure UTC datetime to time_t. Implementation taken
///        from Azure source code. Azure source code unfortunately, has such
///        function only for UTC time
///    @param[in]    dt
///        The Azure datetime object (in microseconds since Jan 1, 1900?)
//---------------------------------------------------------------------
time_t convertFromAzureDateTime(const Azure::DateTime &dt) noexcept {
    // Convert the duration to a long long integer.
    return std::chrono::duration_cast<std::chrono::seconds>(
               dt - Azure::DateTime(1970))
        .count();
}

//---------------------------------------------------------------------
/// @details
///        Processes an entry
///    @param[in]    blob
///        The original Azure blob
///    @param[out]   object
///        Receives the signalled object
///    @param[in]    addObject
///        The function to add the object
///    @returns
///        Error
//---------------------------------------------------------------------
Error IFilterEndpoint::processEntry(
    const Azure::Storage::Blobs::Models::BlobItem &blob, Entry &object,
    const ScanAddObject &addObject) noexcept {
    json::Value metadata;

    // Set the standard stuff
    object.createTime(0);
    object.accessTime(0);

    object.isContainer(false);
    object.name(Path(blob.Name).fileName());
    object.size(blob.BlobSize);
    object.storeSize(blob.BlobSize);
    time_t modifyTime = convertFromAzureDateTime(blob.Details.LastModified);
    object.modifyTime(modifyTime);
    time_t accessTime(0);
    if (blob.Details.LastAccessedOn.HasValue())
        accessTime =
            convertFromAzureDateTime(blob.Details.LastAccessedOn.Value());
    object.accessTime(accessTime);

    time_t createTime = convertFromAzureDateTime(blob.Details.CreatedOn);
    object.createTime(createTime);
    /*metadata["Content-Type"] = _cast<Text>(blob.properties().content_type());
    if (!metadata.empty())
        object.metadata(_mv(metadata));*/

    // Add the object
    return addObject(object);
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
Error IFilterEndpoint::scanObjects(Path &path,
                                   const ScanAddObject &callback) noexcept {
    Entry object;
    uint64_t count = 0;
    auto start = time::now();

    if (path.count() == 1) {
        LOGT("Path is empty, scanning all containers");
        return processContainers(callback);
    }

    LOGT("Scanning container '{}'", path);

    // update Azure client (if needed), and extract path
    std::shared_ptr<Azure::Storage::Blobs::BlobContainerClient>
        blobContainerClient;
    auto errorOrPath = processPath(PATH_PROCESSING_TYPE::ACCOUNT_AND_CONTAINER,
                                   path, blobContainerClient);
    if (errorOrPath.hasCcode()) return errorOrPath.ccode();
    Path &subPath = errorOrPath.value();

    Azure::Storage::Blobs::Models::ListBlobsIncludeFlags includes = {};
    // List max 1000 segments in the container
    int max_results = 1000;

    // prepare root
    auto root = toStr(subPath.gen());

    if (!root.empty()) root += '/';
    if (auto ccode = callAndCatch(_location, "Scan containers", [&]() {
            std::string token{};
            Azure::Storage::Blobs::ListBlobsOptions options;
            options.Prefix = Text(root);
            options.Include = includes;
            options.PageSizeHint = max_results;
            options.ContinuationToken = token;
            // Continue while there are segments matching the prefix in the
            // container
            do {
                // List blobs in the container

                auto response =
                    blobContainerClient->ListBlobsByHierarchy("/", options);

                for (const Azure::Storage::Blobs::Models::BlobItem &blobItem :
                     response.Blobs) {
                    // Skip if Blob marked as deleted
                    if (blobItem.IsDeleted) {
                        continue;
                    }

                    // Skip if Blob is not in Hot Storage
                    auto accessTier = blobItem.Details.AccessTier.ValueOr(
                        Azure::Storage::Blobs::Models::AccessTier::Cold);
                    if (accessTier !=
                        Azure::Storage::Blobs::Models::AccessTier::Hot) {
                        continue;
                    }

                    // Scan each file
                    if (auto tempCcode =
                            processEntry(blobItem, object, callback)) {
                        MONERR(error, tempCcode,
                               "Scanning on directory failed");
                        object.completionCode(tempCcode);
                    }
                }
                for (const auto &folderItem : response.BlobPrefixes) {
                    Path fullPath(folderItem);
                    auto folderName = fullPath.back();
                    Entry parentObject;
                    parentObject.isContainer(true);
                    parentObject.name(folderName);
                    parentObject.modifyTime(0);
                    parentObject.storeSize(0);
                    if (auto ccode = callback(parentObject))
                        object.completionCode(ccode);
                }
                if (!response.NextPageToken.HasValue()) break;
                token = response.NextPageToken.Value();
                if (!token.length()) break;
                options.Prefix = Text(root);
                options.Include = includes;
                options.PageSizeHint = max_results;
                options.ContinuationToken = token;

            } while (token.length());
        })) {
        return ccode;
    }

    LOGT("Scanned container '{}': elapsed {}, completed {} objects", path,
         time::now() - start, count);

    return {};
}

//-----------------------------------------------------------------
/// @details
///        Perform a scan for container objects
///    @param[in]    callback
///        Pass a Entry with all the information filled
//-----------------------------------------------------------------
Error IFilterEndpoint::processContainers(
    const ScanAddObject &callback) noexcept {
    uint64_t count = 0;
    auto start = time::now();
    // storage::continuation_token token{};

    LOGT("Scanning for containers");
    Azure::Storage::Blobs::Models::ListBlobContainersIncludeFlags includes = {};
    // List max 1000 segments in the container
    int max_results = 1000;
    if (auto ccode = callAndCatch(_location, "List containers", [&]() {
            std::string token{};
            Azure::Storage::Blobs::ListBlobContainersOptions options;
            options.Prefix = Text();
            options.Include = includes;
            options.PageSizeHint = max_results;
            options.ContinuationToken = token;

            do {
                // LOGT("Starting blob listing: container '{}',
                // pathvova-qa-data-source-test '{}'...",
                // m_client.container.name(), subPath); List blobs in the
                // container

                LOGT("List all containers");
                auto response =
                    m_client.m_blobServiceClient->ListBlobContainers();

                for (const Azure::Storage::Blobs::Models::BlobContainerItem
                         &blobItem : response.BlobContainers) {
                    // Skip if Blob marked as deleted
                    if (blobItem.IsDeleted) {
                        continue;
                    }
                    LOGT("Found container '{}'", blobItem.Name);
                    Entry containerObject;
                    containerObject.name(Path(blobItem.Name).fileName());
                    containerObject.isContainer(true);
                    if (auto ccode = callback(containerObject)) {
                        MONERR(error, ccode, "Adding callback on container",
                               blobItem.Name, "failed");
                        containerObject.completionCode(ccode);
                    }
                    LOGT("Container '{}' added to processing", blobItem.Name);
                }
                if (!response.NextPageToken.HasValue()) break;
                token = response.NextPageToken.Value();
                if (!token.length()) break;

                options.Include = includes;
                options.PageSizeHint = max_results;
                options.ContinuationToken = token;

            } while (token.length());
        })) {
        return ccode;
    }

    LOGT("Scanned for containers: elapsed {}, completed {} containers",
         time::now() - start, count);
    return {};
}

}  // namespace engine::store::filter::azure
