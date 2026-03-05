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

#include <engLib/eng.h>

namespace engine::store::filter::outlook {

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

    LOGT("Rendering Outlook object {}", object);

    // create new connection
    if (auto ccode = getClient()) {
        object.completionCode(ccode);
        return {};
    }

    do {
        // Output the begin tag
        if ((ccode = sendTagBeginObject(target))) break;

        // body
        if ((ccode = renderStandardFile(target, object))) break;

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
    LOGT("Rendering MS Email object {}", object.fileName());
    Error ccode;
    auto start = time::now();

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if ((ccode = getTagBuffer(&pTagBuffer))) return ccode;

    Text pathName = object.name();

    // Email size is calculated here, no change should be expected
    // If any change, it will be scanned again

    LOGT("Rendering metadata for Email", object.fileName());

    // check if m_data has been filled by prepareObject
    if (m_data.empty()) {
        if (ccode = prepareObject(object)) {
            object.completionCode(ccode);
            return {};
        }
    }

    // Store file metadata
    if (ccode = sendTagMetadata(target, object)) {
        object.completionCode(ccode);
        return {};
    }

    LOGT("Rendering begin stream for Email object {}", object.fileName());
    if (ccode = sendTagBeginStream(target, pTagBuffer, object)) {
        return ccode;
    }

    // Build the tag
    auto const dataSize = m_data.size();
    auto blobSize = dataSize;
    size_t offset = 0;
    while (blobSize) {
        auto sizeToRead = (blobSize > MAX_IOSIZE) ? MAX_IOSIZE : blobSize;

        // Build the tag
        const auto pDataTag = TAG_OBJECT_STREAM_DATA::build(pTagBuffer);
        auto dataBuffer = OutputData(pDataTag->data.data, sizeToRead);
        unsigned char *ptr = dataBuffer.template cast<unsigned char>();
        std::copy(m_data.begin() + offset, m_data.begin() + offset + sizeToRead,
                  ptr);
        // Indicate end of TAG buffer
        pDataTag->setDataSize(_cast<Dword>(sizeToRead));

        // Write the data stream
        if (ccode = pDown->sendTag(target, pDataTag)) return ccode;

        blobSize -= sizeToRead;
        offset += sizeToRead;
    }

    m_data.clear();

    LOGT("Rendering elapsed {}, completed {} object", time::now() - start,
         object.name.get());

    ccode = sendTagEndStream(target);

    // Now, if it was the object that failed, then return the no error since
    // it was not the target, and we can continue
    if (ccode && object.objectFailed()) return {};

    // End the stream
    return ccode;
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
Error IFilterInstance::sendTagMetadata(ServicePipe &target,
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

#ifdef ROCKETRIDE_PLAT_MAC
    data["accessTime"] = static_cast<unsigned long>(object.accessTime());
    data["modifyTime"] = static_cast<unsigned long>(object.modifyTime());
#else
    data["accessTime"] = object.accessTime();
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
///    @param[in]    target
///        The Pipe to render the object to
///    @param[in]    pTagBuffer
///        The tag buffer used for a new tag
///    @param[in]    object
///        The object
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

//-------------------------------------------------------------------------
/// @details
///	    Update the entry size, size of email has to be set to size of the MIME.
///     Email is downloaded as MIME object, so size is different then the size
///     in the store If we use coreScan, this size is never updated and hence
///     during export it fails as the size is different than sent.
///	@param[in]	entry
///		Reference to the object to open
//-------------------------------------------------------------------------
Error IFilterInstance::prepareObject(Entry &entry) noexcept {
    // create new connection
    if (auto ccode = getClient()) {
        entry.completionCode(ccode);
        return {};
    }

    if (auto ccode = getData(entry)) {
        entry.completionCode(ccode);
        return {};
    }
    auto const dataSize = m_data.size();

    // we have size, set now
    entry.size.set(dataSize);
    entry.changeKey.set(_ts(entry.modifyTime(), ";", dataSize));
    return {};
}

//-------------------------------------------------------------------------
/// @details
///	    Get the email in the MIME object
///	@param[in]	entry
///		Reference to the object
//-------------------------------------------------------------------------
Error IFilterInstance::getData(Entry &entry) noexcept {
    // Read the data
    auto data = m_msEmailNode->getMessageInMime(entry);
    if (data.hasCcode()) return data.ccode();

    if (!data.hasValue())
        return MONERR(warning, Ec::NotFound, "Message not found");
    auto values = data.value();

    m_data.insert(m_data.begin(), values.begin(), values.end());
    return {};
}
}  // namespace engine::store::filter::outlook