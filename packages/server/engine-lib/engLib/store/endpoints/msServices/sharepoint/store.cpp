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

namespace engine::store::filter::sharepoint {
using namespace utility;

//-----------------------------------------------------------------
/// @details
///		Public functions used for store
//-----------------------------------------------------------------
Error IFilterInstance::open(Entry &entry) noexcept {
    // Call the parent
    if (auto ccode = Parent::open(entry)) return ccode;

    // Something went wrong if any upload info
    if (!m_uploadSessionUrl.empty())
        return APERRT(Ec::Unexpected,
                      "Sharepoint multipart upload not completed");

    // create new connection
    if (auto ccode = getClient()) return ccode;

    // Create the target path
    if (auto ccode = endpoint.mapPath(entry.url(), m_targetObjectUrl))
        return ccode;

    // Multipart upload
    if (entry.size() > SharePointDefaultPartSize) {
        LOGT("Start multipart upload:", m_targetObjectUrl);
        m_uploadInParts = true;
    }
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Process and write a tag
///	@param[in]	entry
///		The object info from the input pipe
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::writeTag(const TAG *pTag) noexcept {
    // Switch it to generic format so we can read the data values from it
    const TAGS *pTagData = _reCast<const TAGS *>(pTag);

    // Based on the tag type
    switch (pTag->tagId) {
        case TAG_OBJECT_METADATA::ID:
            // Process the metadata
            return processMetadata();
            break;
        case TAG_OBJECT_STREAM_BEGIN::ID:
            // Begin a new stream within the object
            break;
        case TAG_OBJECT_STREAM_DATA::ID:
            // Write stream data
            if (auto ccode = processObjectStreamData(&pTagData->streamData))
                return ccode;
            break;
        case TAG_OBJECT_STREAM_END::ID:
            // Write stream data
            break;
        default:
            // Ignore any unknown tags
            LOGT("Got unknown tag:", pTag->tagId, Type);
            break;
    }

    // Done processing this tag
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Proesses the data within the stream
///	@param[in]	pTag
///		The stream data tag
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::processObjectStreamData(
    const TAG_OBJECT_STREAM_DATA *pTag) noexcept {
    // Skip if object failed
    if (currentEntry->objectFailed()) return {};

    auto filePath = m_targetObjectUrl.path();

    auto data = _cast<const Byte *>(pTag->data.data);
    auto dataSize = pTag->size;
    size_t totalSize = currentEntry->size();
    if (m_uploadInParts) {
        // no session url, task will not complete.
        if (m_uploadSessionUrl.empty()) {
            // Get the SiteName, path format "/siteName/filepath"
            Text sharepointName = filePath.at(SITENAME_POS);
            auto siteIdCcode = endpoint.getTargetSiteId(sharepointName);
            if (siteIdCcode.hasCcode()) return siteIdCcode.ccode();
            Text siteId = siteIdCcode.value();
            auto uploadUrl = m_msSharepointNode->getUploadSession(
                currentEntry, siteId, m_targetObjectUrl.path());
            if (uploadUrl.hasCcode() || !uploadUrl.hasValue()) {
                currentEntry->completionCode(APERR(Ec::Warning, "failed"));
                return {};
            }
            // clean
            m_msSharepointNode->clearSizes();
            m_targetObjectDataBuffer.clear();
            m_uploadSessionUrl = uploadUrl.value();
            m_msSharepointNode->setTotalSize(currentEntry->size());
        }

        while (dataSize > 0) {
            const size_t lastUploaded = m_msSharepointNode->getPartUploaded();

            auto copySize = _cast<size_t>(SharePointDefaultPartSize) > dataSize
                                ? dataSize
                                : _cast<size_t>(SharePointDefaultPartSize);

            m_targetObjectDataBuffer.append(data, copySize);
            data += copySize;
            dataSize -= _cast<Dword>(copySize);

            if (m_targetObjectDataBuffer.size() >= SharePointDefaultPartSize ||
                m_targetObjectDataBuffer.size() + lastUploaded >= totalSize) {
                if (auto ccode = uploadWithSession())
                    currentEntry->completionCode(ccode);

                m_targetObjectDataBuffer.clear();
            }

            // Skip if object failed
            if (currentEntry->objectFailed()) return {};
        }
    } else {
        // Ad-fill the buffer with the next data chunk
        if (dataSize) m_targetObjectDataBuffer.append(data, dataSize);

        if (m_targetObjectDataBuffer.size() >= currentEntry->size()) {
            if (auto ccode = uploadWithoutSession())
                currentEntry->completionCode(ccode);
            m_targetObjectDataBuffer.clear();
        }
    }
    // And done without error
    return {};
}

//------------------------------------------------------------------
/// @details
///		close the stream
///	@returns
///		Error
//------------------------------------------------------------------
Error IFilterInstance::close() noexcept {
    if (m_targetObjectDataBuffer.size()) {
        if (m_uploadInParts) {
            if (!m_uploadSessionUrl.empty())
                if (auto ccode = uploadWithSession())
                    currentEntry->completionCode(ccode);
        } else {
            if (m_targetObjectDataBuffer.size() >= currentEntry->size()) {
                if (auto ccode = uploadWithoutSession())
                    currentEntry->completionCode(ccode);
                m_targetObjectDataBuffer.clear();
            } else {
                return APERR(Ec::Failed, "file failed to be uploaded:",
                             currentEntry->name());
            }
        }
    }
    m_uploadInParts = false;
    m_uploadSessionUrl = Text();
    body.clear();
    m_msSharepointNode->clearSizes();
    m_targetObjectDataBuffer.clear();

    return Parent::close();
}

//------------------------------------------------------------------
/// @details
///		upload a file
///	@returns
///		Error
//------------------------------------------------------------------
Error IFilterInstance::uploadWithoutSession() noexcept {
    auto filePath = m_targetObjectUrl.path();
    // Get the SiteName, path format "/siteName/filepath"
    Text sharepointName = filePath.at(SITENAME_POS);
    auto siteIdCcode = endpoint.getTargetSiteId(sharepointName);
    if (siteIdCcode.hasCcode()) return siteIdCcode.ccode();
    Text siteId = siteIdCcode.value();
    if (auto ccode = m_msSharepointNode->uploadFile(
            currentEntry, siteId, filePath, m_targetObjectDataBuffer)) {
        currentEntry->completionCode(ccode);
    }
    return {};
}

//------------------------------------------------------------------
/// @details
///		upload a file with session url
///	@returns
///		Error
//------------------------------------------------------------------
Error IFilterInstance::uploadWithSession() noexcept {
    if (auto ccode = m_msSharepointNode->uploadFileInParts(
            m_uploadSessionUrl, m_targetObjectDataBuffer))
        currentEntry->completionCode(ccode);

    return {};
}

//--------------------------------------------------------------------------------------------
/// @details
///		Checks whether the Azure blob exists, and should be replaced if exists.
///     Existent Azure blob is not updated when either `update` option is set to
///     `skip`, or when `update` option is set to `update`, and the modification
///     time is equal to the modification time of the Azure blob (specified
///     using corresponding tag). If corresponding tag doesn't exist, and option
///     is set to `update`, the Azure blob is overwritten In all other cases
///     Azure blob is created (if doesn't exist) or updated.
///	@returns
///		Error
//--------------------------------------------------------------------------------------------
Error IFilterInstance::isObjectUpdateNeeded() noexcept {
    if (endpoint.config.exportUpdateBehavior == EXPORT_UPDATE_BEHAVIOR::UNKNOWN)
        return {};

    // Create the target path
    if (auto ccode = endpoint.mapPath(currentEntry->url(), m_targetObjectUrl))
        return ccode;
    // get the filename
    auto filePath = m_targetObjectUrl.path();
    // Get the SiteName, path format "/siteName/filepath"
    Text sharepointName = filePath.at(SITENAME_POS);
    auto siteIdCcode = endpoint.getTargetSiteId(sharepointName);
    if (siteIdCcode.hasCcode()) return siteIdCcode.ccode();
    Text siteId = siteIdCcode.value();

    auto ccode =
        m_msSharepointNode->getMetaDataUsingPath(siteId, filePath.str());

    if (ccode.hasCcode()) {
        LOGT("File does not exist", m_targetObjectUrl);
        return {};
    }
    Entry object = ccode.value();
    // file exist
    if (endpoint.config.exportUpdateBehavior == EXPORT_UPDATE_BEHAVIOR::SKIP) {
        LOGT("Skipping existent object", m_targetObjectUrl);
        currentEntry->completionCode(
            APERR(Ec::Skipped, "Skipping existent file"));
        return {};
    }
    if (endpoint.config.exportUpdateBehavior ==
        EXPORT_UPDATE_BEHAVIOR::UPDATE) {
        if (object.modifyTime() == currentEntry->modifyTime()) {
            LOGT("Sharepoint", m_targetObjectDataBuffer,
                 "has unchanged last modified time");
            currentEntry->completionCode(
                APERR(Ec::Skipped,
                      "Timestamp the same:", currentEntry->modifyTime()));
            return {};
        }
        LOGT("Sharepoint", m_targetObjectDataBuffer,
             "has either different last modified time, or is not set");
        return {};
    }
    LOGT("Unexpected value for `update` flag, doing rewrite");
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Processes the metadata saved with the object. Currently, just calls
///     the function to check if the corresponding objects exists on the cloud
///     and if it is new/older than the object in processing
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::processMetadata() noexcept {
    Error ccode;
    m_updateObject = true;
    // check if blob exists according to the `update` flag
    if ((ccode = isObjectUpdateNeeded()) || currentEntry->objectFailed()) {
        m_updateObject = false;
        return ccode;
    }
    return {};
}

}  // namespace engine::store::filter::sharepoint