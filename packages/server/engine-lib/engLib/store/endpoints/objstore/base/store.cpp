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

namespace engine::store::filter::baseObjectStore {
//-------------------------------------------------------------------------
/// Constants
//-------------------------------------------------------------------------
_const auto metadataKey = "_OriginalMetadata";

//-------------------------------------------------------------------------
/// @details
///		Prepare to write a file in native mode
///	@param[in]	entry
///		The object info from the input pipe
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IBaseInstance::open(Entry &entry) noexcept {
    // Call the parent
    if (auto ccode = Parent::open(entry)) return ccode;

    // Something went wrong if any upload info
    if (!m_targetObjectUploadId.empty() || m_targetObjectUploadSize != 0 ||
        m_targetObjectUploadPartSize != 0 ||
        !m_targetObjectDataBuffer.empty() ||
        m_targetObjectCompletedMultipartUpload.GetParts().size() > 0)
        return APERRT(Ec::Unexpected, "AWS S3 multipart upload not completed");

    // Create the target path
    if (auto ccode = endpoint.mapPath(entry.url(), m_targetObjectUrl))
        return ccode;

    // check if blob exists according to the `update` flag
    // if object shouldn't be updated -> return immediately without error
    // however, the result of the check is stored to be returned from the
    // `writeTag` step
    if ((m_updateObject = isObjectUpdateNeeded()) ||
        currentEntry->objectFailed())
        return {};

    // Multipart upload
    if (entry.size() > AwsDefaultPartSize) {
        LOGT("Start multipart upload:", m_targetObjectUrl);

        // Calculate size of buffer for multipart upload
        m_targetObjectUploadPartSize =
            std::max(_cast<size_t>(std::floor(_cast<double>(entry.size()) /
                                              AwsMaxPartNumber)),
                     _cast<size_t>(AwsDefaultPartSize));

        // Make request to start multipart upload
        auto rqs =
            endpoint.makeRequest<Aws::S3::Model::CreateMultipartUploadRequest>(
                m_targetObjectUrl);

        // Send request to start multipart upload
        if (auto ccode = ensureClient()) return ccode;
        auto res = m_streamClient->CreateMultipartUpload(rqs);
        if (!res.IsSuccess())
            // Fail the whole task if unable to start multipart upload
            return errorFromS3Error(m_streamClient, _location, res.GetError());

        // Store multipart upload id for futher requests
        m_targetObjectUploadId = res.GetResult().GetUploadId();
    }
    // Single part upload
    else {
        // Set size of buffer to put object
        m_targetObjectUploadPartSize = AwsDefaultPartSize;
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
Error IBaseInstance::writeTag(const TAG *pTag) noexcept {
    // if previous status of update object indicated that object should be
    // skipped, return it as error
    if (m_updateObject || currentEntry->objectFailed()) return m_updateObject;

    // Switch it to generic format so we can read the data values from it
    const TAGS *pTagData = _reCast<const TAGS *>(pTag);

    Error ccode = {};

    // Based on the tag type
    switch (pTag->tagId) {
        case TAG_OBJECT_STREAM_BEGIN::ID:
            // Begin a new stream within the object
            break;
        case TAG_OBJECT_STREAM_DATA::ID:
            // Write stream data
            ccode = processObjectStreamData(&pTagData->streamData);
            break;
        case TAG_OBJECT_STREAM_END::ID:
            // Write stream data
            break;
        default:
            // Ignore any unknown tags
            break;
    }

    // Done processing this tag
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Finished writing a file. Close it out
//-------------------------------------------------------------------------
Error IBaseInstance::close() noexcept {
    // Upload the latest data part if the object is ok
    if (!currentEntry->objectFailed() && !m_updateObject) {
        if (auto ccode = uploadTargetObjectPart(true)) return ccode;
    }

    // Multipart upload
    if (m_targetObjectUploadId) {
        // Complete multipart upload if the object is still ok
        if (!currentEntry->objectFailed()) {
            LOGT("Complete multipart upload:", m_targetObjectUrl);

            // Create request to complete multipart upload
            auto rqs = endpoint
                           .makeRequest<
                               Aws::S3::Model::CompleteMultipartUploadRequest>(
                               m_targetObjectUrl)
                           .WithUploadId(m_targetObjectUploadId)
                           .WithMultipartUpload(
                               m_targetObjectCompletedMultipartUpload);

            // Send request to complete multipart upload
            if (auto ccode = ensureClient()) return ccode;
            auto res = m_streamClient->CompleteMultipartUpload(rqs);
            if (!res.IsSuccess()) {
                auto ccode =
                    errorFromS3Error(m_streamClient, _location, res.GetError());
                currentEntry->completionCode(ccode);
            }
        }

        // Abort multipart upload if the object was failed
        if (currentEntry->objectFailed()) {
            LOGT("Abort multipart upload:", m_targetObjectUrl);

            // Create request to abort multipart upload
            auto rqs =
                endpoint
                    .makeRequest<Aws::S3::Model::AbortMultipartUploadRequest>(
                        m_targetObjectUrl)
                    .WithUploadId(m_targetObjectUploadId);

            // Send request to abort multipart upload
            if (auto ccode = ensureClient()) return ccode;
            auto res = m_streamClient->AbortMultipartUpload(rqs);
            if (!res.IsSuccess()) {
                // Fail the whole task if aborting multipart upload failed
                return errorFromS3Error(m_streamClient, _location,
                                        res.GetError());
            }
        }
    }

    // Set metadata
    if (auto ccode = setMetadata()) currentEntry->completionCode(ccode);

    // Clear multipart upload info
    m_targetObjectUploadId.clear();
    m_targetObjectUploadSize = 0;
    m_targetObjectUploadPartSize = 0;
    m_targetObjectDataBuffer.clear();
    m_targetObjectCompletedMultipartUpload = {};

    return Parent::close();
}

//-------------------------------------------------------------------------
/// @details
///		Proesses the data within the stream
///	@param[in]	pTag
///		The stream data tag
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IBaseInstance::processObjectStreamData(
    const TAG_OBJECT_STREAM_DATA *pTag) noexcept {
    // Skip if object failed
    if (currentEntry->objectFailed()) return {};

    auto data = _cast<const Byte *>(pTag->data.data);
    auto dataSize = pTag->size;

    // Upload data buffer if full
    while (m_targetObjectDataBuffer.size() + dataSize >
           m_targetObjectUploadPartSize) {
        // Get free space in the buffer
        auto copySize =
            m_targetObjectUploadPartSize > m_targetObjectDataBuffer.size()
                ? m_targetObjectUploadPartSize - m_targetObjectDataBuffer.size()
                : 0;

        if (copySize) {
            // Fill free space of the buffer with the part of the next data
            // chunk
            m_targetObjectDataBuffer.append(data, copySize);
            data += copySize;
            dataSize -= _cast<Dword>(copySize);
        }

        // Upload data buffer
        if (auto ccode = uploadTargetObjectPart(false)) return ccode;

        // Skip if object failed
        if (currentEntry->objectFailed()) return {};
    }

    // Ad-fill the buffer with the next data chunk
    if (dataSize) m_targetObjectDataBuffer.append(data, dataSize);

    // And done without error
    return {};
}

Error IBaseInstance::uploadTargetObjectPart(bool latestPart) noexcept {
    // Skip if object is failed
    if (currentEntry->objectFailed()) return {};

    // Multipart upload
    if (m_targetObjectUploadId) {
        // Done if nothing to upload
        if (m_targetObjectDataBuffer.size() == 0) return {};

        auto logUploadStatus = localfcn() {
            LOGT("Multipart upload: {} {}% {} / {}", m_targetObjectUrl,
                 _cast<int>((double)m_targetObjectUploadSize /
                            currentEntry->size() * 100),
                 Size(m_targetObjectUploadSize), Size(currentEntry->size()));
        };
        logUploadStatus();

        // Make request to upload part of data
        auto rqs =
            endpoint
                .makeRequest<Aws::S3::Model::UploadPartRequest>(
                    m_targetObjectUrl)
                .WithUploadId(m_targetObjectUploadId)
                .WithPartNumber(_cast<int>(
                    m_targetObjectCompletedMultipartUpload.GetParts().size() +
                    1))
                .WithContentLength(m_targetObjectDataBuffer.size());

        // Set request body with current data
        auto body = Aws::MakeShared<Aws::StringStream>(AllocTag);
        body->write(m_targetObjectDataBuffer.cast<const char>(),
                    m_targetObjectDataBuffer.size());
        rqs.SetBody(body);

        // Send request to upload part of data
        if (auto ccode = ensureClient()) return ccode;
        auto res = m_streamClient->UploadPart(rqs);
        if (!res.IsSuccess()) {
            auto ccode =
                errorFromS3Error(m_streamClient, _location, res.GetError());
            currentEntry->completionCode(ccode);
            return {};
        }

        // Save uploaded part to complete multipart upload
        auto completedPart =
            Aws::S3::Model::CompletedPart()
                .WithPartNumber(_cast<int>(
                    m_targetObjectCompletedMultipartUpload.GetParts().size() +
                    1))
                .WithETag(res.GetResult().GetETag());
        m_targetObjectCompletedMultipartUpload.AddParts(_mv(completedPart));

        m_targetObjectUploadSize += m_targetObjectDataBuffer.size();

        if (latestPart) {
            logUploadStatus();

            if (currentEntry->size() != m_targetObjectUploadSize)
                MONERR(warning, Ec::Warning,
                       "Object size not matched data size",
                       currentEntry->path());
        }
    }
    // Single part upload
    else {
        if (!latestPart)
            return APERR(Ec::Unexpected, "The whole object to upload expected");

        if (currentEntry->size() != m_targetObjectDataBuffer.size())
            MONERR(warning, Ec::Warning, "Object size not matched data size",
                   currentEntry->path());

        LOGT("Upload:", m_targetObjectUrl, "100%",
             Size(m_targetObjectDataBuffer.size()));

        // Make request to upload the object
        auto rqs = endpoint
                       .makeRequest<Aws::S3::Model::PutObjectRequest>(
                           m_targetObjectUrl)
                       .WithContentLength(m_targetObjectDataBuffer.size());

        // Set request body with current data
        if (m_targetObjectDataBuffer.size()) {
            auto body = Aws::MakeShared<Aws::StringStream>(AllocTag);
            body->write(m_targetObjectDataBuffer.cast<const char>(),
                        m_targetObjectDataBuffer.size());
            rqs.SetBody(body);
        }

        // Send request to upload the object
        if (auto ccode = ensureClient()) return ccode;
        auto res = m_streamClient->PutObject(rqs);
        if (!res.IsSuccess()) {
            auto ccode =
                errorFromS3Error(m_streamClient, _location, res.GetError());
            currentEntry->completionCode(ccode);
            return {};
        }
    }

    // Clear uploaded data
    m_targetObjectDataBuffer.clear();

    return {};
}

//-----------------------------------------------------------------------------
/// @details
///		Recover metadata using a current file
///	@returns
///		Error
//-----------------------------------------------------------------------------
Error IBaseInstance::setMetadata() noexcept {
    if (m_updateObject || currentEntry->objectFailed()) return {};

    json::Value metadata;
#ifdef ROCKETRIDE_PLAT_MAC
    metadata["mtime"] = static_cast<unsigned long>(currentEntry->modifyTime());
#else
    metadata["mtime"] = currentEntry->modifyTime();
#endif
    auto metadataValue = ap::crypto::base64Encode(metadata.stringify(false));

    if (auto ccode = ensureClient()) return ccode;

    auto grqs = endpoint.makeRequest<Aws::S3::Model::GetObjectTaggingRequest>(
        m_targetObjectUrl);
    auto grqsOutcome = m_streamClient->GetObjectTagging(grqs);

    // tagging is not available on S3-compatible, for example on Wasabi
    // not an error
    if (grqsOutcome.IsSuccess()) {
        auto tagSet = grqsOutcome.GetResult().GetTagSet();

        // Find the tag to add or modify
        bool tagFound = false;
        for (auto &tag : tagSet) {
            if (tag.GetKey() == metadataKey) {
                tag.SetValue(metadataValue);
                tagFound = true;
                break;
            }
        }
        // Add the new tag if it doesn't exist
        if (!tagFound) {
            auto newTag = Aws::S3::Model::Tag()
                              .WithKey(metadataKey)
                              .WithValue(metadataValue);
            tagSet.push_back(newTag);
        }

        auto tagging = Aws::S3::Model::Tagging().WithTagSet(tagSet);
        auto prqs = endpoint
                        .makeRequest<Aws::S3::Model::PutObjectTaggingRequest>(
                            m_targetObjectUrl)
                        .WithTagging(tagging);

        auto res = m_streamClient->PutObjectTagging(prqs);
        if (!res.IsSuccess()) {
            // return error
            return errorFromS3Error(m_streamClient, _location, res.GetError());
        }
    } else {
        LOGT("Couldn't get tag information for the AWS object",
             m_targetObjectUrl, ", skipping metadata update");
    }

    return {};
}

//--------------------------------------------------------------------------------------------
/// @details
///		Checks whether the AWS object exists, and should be replaced if exists.
///     Existent AWS object is not updated when either `update` option is set to
///     `skip`, or when `update` option is set to `update`, and the modification
///     time is equal to the modification time of the AWS object (specified
///     using corresponding tag). If corresponding tag doesn't exist, and option
///     is set to `update`, the AWS object is overwritten In all other cases AWS
///     object is created (if doesn't exist) or updated.
///	@returns
///		Error
//--------------------------------------------------------------------------------------------
Error IBaseInstance::isObjectUpdateNeeded() noexcept {
    if (endpoint.config.exportUpdateBehavior == EXPORT_UPDATE_BEHAVIOR::UNKNOWN)
        return {};

    if (auto ccode = ensureClient()) return ccode;

    auto grqs = endpoint.makeRequest<Aws::S3::Model::GetObjectTaggingRequest>(
        m_targetObjectUrl);
    auto grqsOutcome = m_streamClient->GetObjectTagging(grqs);
    if (!grqsOutcome.IsSuccess()) {
        LOGT("Couldn't get tag information for the AWS object",
             m_targetObjectUrl, "the object would be updated");
        return {};
    }

    // object is present here ...
    if (endpoint.config.exportUpdateBehavior == EXPORT_UPDATE_BEHAVIOR::SKIP) {
        LOGT("Skipping existent blob", m_targetObjectUrl);
        currentEntry->completionCode(
            APERR(Ec::Skipped, "Skipping existent file"));
        return {};
    }

    if (endpoint.config.exportUpdateBehavior ==
        EXPORT_UPDATE_BEHAVIOR::UPDATE) {
        // find corresponding tag
        auto tagSet = grqsOutcome.GetResult().GetTagSet();
        auto iter = std::find_if(tagSet.begin(), tagSet.end(),
                                 [&](const Aws::S3::Model::Tag &t) {
                                     return t.GetKey() == metadataKey;
                                 });

        // tag doesn't exist -> update file
        if (iter == tagSet.end()) {
            LOGT("Metadata tag not present for the AWS object",
                 m_targetObjectUrl);
            return {};
        }

        // decode corresponding tag
        ErrorOr<Buffer> errorOrDecoded =
            ap::crypto::base64Decode(iter->GetValue());
        if (errorOrDecoded.hasCcode()) {
            LOGT("Metadata tag couldn't be decoded", m_targetObjectUrl);
            return {};
        }

        ErrorOr<json::Value> errorOrJson =
            _fd<json::Value>(errorOrDecoded.value());
        if (errorOrJson.hasCcode()) {
            LOGT("Metadata could not be parsed for the AWS object ",
                 m_targetObjectUrl);
            return {};
        }

        json::Value jsonMetadata = *errorOrJson;
        if (jsonMetadata.isMember("mtime")) {
            auto jsonMTime = jsonMetadata["mtime"];
            if (jsonMTime.isIntegral() &&
                jsonMTime.asInt64() == currentEntry->modifyTime()) {
                LOGT("Last modified time is the same for the AWS object",
                     m_targetObjectUrl);
                currentEntry->completionCode(
                    APERR(Ec::Skipped,
                          "Timestamp the same:", currentEntry->modifyTime()));
                return {};
            }
        }

        LOGT(
            "Either different last modified time, or is not set for the AWS "
            "object",
            m_targetObjectUrl);
        return {};
    }

    LOGT("Unexpected value for `update` flag, doing rewrite for the AWS object",
         m_targetObjectUrl);
    return {};
}

}  // namespace engine::store::filter::baseObjectStore