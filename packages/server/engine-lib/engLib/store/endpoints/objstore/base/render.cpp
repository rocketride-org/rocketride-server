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
//    Defines the object render for Objstore files - this renders a native
//    object on the S3 compatible system into a tagged format
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::baseObjectStore {
//-------------------------------------------------------------------------
/// @details
///        Store an object
///    @param[in]    target
///        the output channel
///    @param[in]    object
///        object information
///    @returns
///        Error
//-------------------------------------------------------------------------
Error IBaseInstance::renderObject(ServicePipe &target, Entry &object) noexcept {
    Error ccode;

    // Output the begin tag
    if ((ccode = sendTagBeginObject(target)) || object.objectFailed())
        goto done;

    if ((ccode = renderStandardFile(target, object)) || object.objectFailed())
        goto done;

    // Output the end tag
    ccode = sendTagEndObject(target, ccode);

done:
    // Now, if it was the object that failed, then return the no
    // error since it was not the target, and we can continue
    if (ccode && object.objectFailed())
        return {};
    else
        return ccode;
};
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
Error IBaseInstance::renderStandardFile(ServicePipe &target,
                                        Entry &object) noexcept {
    Error ccode;
    auto start = time::now();
    Dword sizeToRead = 0;

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if ((ccode = getTagBuffer(&pTagBuffer))) return ccode;

    // Get the path
    Text path;
    if (ccode = Url::toPath(object.url(), path)) return ccode;

    Text bucket, key;
    endpoint.extractBucketAndKeyFromPath(path, bucket, key);

    // Define a request to read the file
    const auto objectsReq =
        Aws::S3::Model::GetObjectRequest().WithBucket(bucket).WithKey(key);

    // get the object from the bucket
    auto objectsResp = m_streamClient->GetObject(objectsReq);
    if (!objectsResp.IsSuccess()) {
        object.completionCode(
            APERR(Ec::Error, objectsResp.GetError().GetExceptionName().c_str(),
                  objectsResp.GetError().GetMessage().c_str()));
        return {};
    }

    auto &retrievedFile = objectsResp.GetResultWithOwnership().GetBody();
    auto streamSize = objectsResp.GetResult().GetContentLength();

    // Store file metadata
    if (ccode = sendTagMetadata(target, object)) {
        object.completionCode(ccode);
        return {};
    }
    if (object.objectFailed()) return {};

    if (ccode = sendTagBeginStream(retrievedFile, target, pTagBuffer, object)) {
        object.completionCode(ccode);
        return {};
    }
    if (object.objectFailed()) return {};

    // While we have bytes to retrieve
    while (streamSize) {
        // Get the amount of data we are going to read in this pass
        if (streamSize > MAX_IOSIZE)
            sizeToRead = MAX_IOSIZE;
        else
            sizeToRead = (Dword)streamSize;

        // Build the tag
        auto pDataTag = TAG_OBJECT_STREAM_DATA::build(pTagBuffer);
        auto dataBuffer = OutputData(pDataTag->data.data, sizeToRead);

        // Read the data and set the size we read
        retrievedFile.rdbuf()->sgetn(dataBuffer.template cast<char>(),
                                     sizeToRead);

        // Move on
        streamSize -= sizeToRead;
        pDataTag->setDataSize(sizeToRead);

        // Write the data stream
        if (ccode = pDown->sendTag(target, pDataTag)) {
            object.completionCode(ccode);
            return {};
        }
        if (object.objectFailed()) return {};
    }

    LOGT("Rendering elapsed {}, completed {} object", time::now() - start,
         object.name.get());

    // End the stream
    if (ccode = sendTagEndStream(target)) {
        object.completionCode(ccode);
        return {};
    }
    // no need to check completion code...

    return {};
}
//-------------------------------------------------------------------------
/// @details
///        Starts rendering the metadata
///    @param[in]    target
///        The Pipe to render the object to
///    @param[in]    object
///        The entry object
///    @returns
///        Error
//-------------------------------------------------------------------------
Error IBaseInstance::sendTagMetadata(ServicePipe &target,
                                     Entry &object) noexcept {
    Error ccode;

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if ((ccode = getTagBuffer(&pTagBuffer))) return ccode;

    // Get the path
    Text path;
    if (ccode = Url::toPath(object.url(), path)) return ccode;

    json::Value data;
    // Unset Windows flag
    data["flags"] = TAG_OBJECT_METADATA::FLAGS::NONE;
    data["path"] = path;
    data["url"] = (TextView)object.url.get().fullpath().gen();
    data["isContainer"] = false;
    data["isLink"] = false;
    data["size"] = object.size.get();
    data["accessTime"] = 0;
#ifdef ROCKETRIDE_PLAT_MAC
    data["modifyTime"] = static_cast<unsigned long>(object.modifyTime());
#else
    data["modifyTime"] = object.modifyTime();
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
Error IBaseInstance::sendTagBeginStream(Aws::IOStream &fileStream,
                                        ServicePipe &target, TAG *pTagBuffer,
                                        Entry &object) noexcept {
    // Setup
    auto type = TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_DATA;
    size_t streamOffset = 0;

    fileStream.seekg(streamOffset, std::ios_base::beg);

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
Error IBaseInstance::sendTagEndStream(ServicePipe &target) noexcept {
    // Create the tag
    const auto streamEndTag = TAG_OBJECT_STREAM_END();

    // Write the stream end tag
    return pDown->sendTag(target, &streamEndTag);
};

}  // namespace engine::store::filter::baseObjectStore