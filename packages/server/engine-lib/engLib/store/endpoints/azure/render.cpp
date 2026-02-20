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
//    Defines the object render for Azure files - this renders a native
//    object on the Azure into a tagged format
//
//-----------------------------------------------------------------------------
namespace engine::store::filter::azure {
//-------------------------------------------------------------------------
/// @details
///     Render object
/// @param[in]  target
///     the output channel
/// @param[in]  object
///     object information
/// @returns
///     Error
//-------------------------------------------------------------------------
Error IFilterInstance::renderObject(ServicePipe &target,
                                    Entry &object) noexcept {
    Error ccode;

    LOGT("Rendering Azure object {}", object.fileName());

    do {
        // Output the begin tag
        if ((ccode = sendTagBeginObject(target)) || object.objectFailed())
            break;

        // body
        if ((ccode = renderStandardFile(target, object)) ||
            object.objectFailed())
            break;

        // Output the end tag
        ccode = sendTagEndObject(target, ccode);
    } while (false);

    // Now, if it was the object that failed, then return the no
    // error since it was not the target, and we can continue
    return (ccode && object.objectFailed()) ? Error() : ccode;
}

//-------------------------------------------------------------------------
/// @details
///        Store a standard file
///    @param[in]    target
///        The target endpoint to which to send data
///    @param[in]    object
///        The filled in object from the job runner
///    @returns
///        Error
//-------------------------------------------------------------------------
Error IFilterInstance::renderStandardFile(ServicePipe &target,
                                          Entry &object) noexcept {
    LOGT("Rendering Azure blob object {}", object.fileName());
    Error ccode;
    auto start = time::now();

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if ((ccode = getTagBuffer(&pTagBuffer))) return ccode;

    std::shared_ptr<Azure::Storage::Blobs::BlobContainerClient>
        blobContainerClient;
    auto errorOr = processPath(object, blobContainerClient);
    if (errorOr.hasCcode()) {
        return errorOr.ccode();
    }

    Text pathName = errorOr.value().gen();

    LOGT("Rendering Azure blob object {}", pathName);
    try {
        auto blob = blobContainerClient->GetBlobClient(
            Text(object.url().path().subpth(2)));
        Azure::Response<Azure::Storage::Blobs::Models::BlobProperties>
            blobProperties = blob.GetProperties();
        auto blobValues = blobProperties.Value;

        // Skip if Blob is not in Hot Storage
        auto accessTier = blobValues.AccessTier.ValueOr(
            Azure::Storage::Blobs::Models::AccessTier::Cold);
        if (accessTier != Azure::Storage::Blobs::Models::AccessTier::Hot) {
            return MONERR(
                warning, Ec::Warning,
                "Skipping: Blob has been moved out of the hot storage",
                pathName);
        }

        // Store file metadata
        LOGT("Rendering metadata for Azure object {}", object.fileName());
        if (ccode = sendTagMetadata(target, object)) {
            return ccode;
        }
        if (object.objectFailed()) return {};

        LOGT("Rendering begin stream for Azure object {}", object.fileName());
        if (ccode = sendTagBeginStream(target, pTagBuffer, object)) {
            return ccode;
        }
        if (object.objectFailed()) return {};

        auto blobSize = blobValues.BlobSize;
        size_t offset = 0;
        while (blobSize) {
            auto sizeToRead = (blobSize > MAX_IOSIZE) ? MAX_IOSIZE : blobSize;
            Azure::Storage::Blobs::DownloadBlobToOptions options;
            // Build the tag
            const auto pDataTag = TAG_OBJECT_STREAM_DATA::build(pTagBuffer);
            auto dataBuffer = OutputData(pDataTag->data.data, sizeToRead);

            Azure::Core::Http::HttpRange range;
            range.Offset = (int64_t)offset;
            range.Length = sizeToRead;
            options.Range = range;

            blob.DownloadTo(dataBuffer, dataBuffer.size(), options);

            // Indicate end of TAG buffer
            pDataTag->setDataSize(_cast<Dword>(sizeToRead));

            // Write the data stream
            if (ccode = pDown->sendTag(target, pDataTag)) return ccode;
            if (object.objectFailed()) return {};

            blobSize -= sizeToRead;
            offset += sizeToRead;
        }
    } catch (const std::exception &) {
        // Handle exceptions that may occur when trying to get the blob
        // properties.
        return APERR(Ec::Unexpected, _location,
                     "Azure blob check for existance: blob '", pathName,
                     "' doesn't exist");
    }

    // End the stream
    ccode = sendTagEndStream(target);

    // Now, if it was the object that failed, then return the no error since
    // it was not the target, and we can continue
    if (ccode && object.objectFailed()) return {};

    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///        Render metadata
///    @param[in]    target
///        The target endpoint to which to send data
///    @param[in]    object
///        The filled in object from the job runner
///    @returns
///        Error
//-------------------------------------------------------------------------
Error IFilterInstance::sendTagMetadata(ServicePipe &target,
                                       Entry &object) noexcept {
    // Get the internal tag buffer
    TAG *pTagBuffer;
    if (auto ccode = getTagBuffer(&pTagBuffer)) return ccode;

    json::Value data;
    // Unset Windows flag
    data["flags"] = TAG_OBJECT_METADATA::FLAGS::NONE;
    data["path"] = object.parentId.get();
    data["url"] = (TextView)object.url.get().fullpath().gen();
    data["isContainer"] = false;
    data["isLink"] = false;
    data["size"] = object.size.get();
    data["accessTime"] = 0;
#ifdef ROCKETRIDE_PLAT_MAC
    data["modifyTime"] = static_cast<unsigned long>(object.modifyTime());
    data["createTime"] = static_cast<unsigned long>(object.createTime());
#else
    data["modifyTime"] = object.modifyTime();
    data["createTime"] = object.createTime();
#endif
    data["objstore"] = object.metadata.get().stringify(true);

    // Stringify the json object
    auto metadataString = data.stringify(true);

    // Build the tag
    const auto pMetadata =
        TAG_OBJECT_METADATA::build(pTagBuffer, &metadataString)
            ->setAttributes(TAG_ATTRIBUTES::INSTANCE_DATA);

    // Write it out
    return pDown->sendTag(target, pMetadata);
}

//-------------------------------------------------------------------------
/// @details
///        Starts rendering the file data
///    @param[in]    fileHandle
///        The file descriptor to render from
///    @param[in]    target
///        The Pipe to render the object to
///    @param[in]    pTagBuffer
///        The tag buffer used for a new tag
///    @param[in]    type
///        The object stream type
///    @returns
///        Error
//-------------------------------------------------------------------------
Error IFilterInstance::sendTagBeginStream(ServicePipe &target, TAG *pTagBuffer,
                                          Entry &object) noexcept {
    // Setup
    auto type = TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_DATA;
    size_t streamOffset = 0;

    // Setup the default stream begin tag
    auto pStreamBeginTag = TAG_OBJECT_STREAM_BEGIN::build(pTagBuffer, type);

    pStreamBeginTag->setStreamOffset(streamOffset);

    // Write it
    if (auto ccode = pDown->sendTag(target, pStreamBeginTag)) return ccode;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///        Ends rendering the file data
///    @param[in]    target
///        The Pipe to render the object to
///    @returns
///        Error
//-------------------------------------------------------------------------
Error IFilterInstance::sendTagEndStream(ServicePipe &target) noexcept {
    // Create the tag
    const auto streamEndTag = TAG_OBJECT_STREAM_END();

    // Write the stream end tag
    return pDown->sendTag(target, &streamEndTag);
};
}  // namespace engine::store::filter::azure
