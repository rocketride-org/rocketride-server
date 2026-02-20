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

#include <engLib/eng.h>

namespace engine::store::filter::azure {
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
Error IFilterInstance::open(Entry &entry) noexcept {
    // Call the parent
    if (auto ccode = Parent::open(entry)) return ccode;

    // Something went wrong if any upload info
    if (!m_targetObjectDataBuffer.empty())
        return APERRT(Ec::Unexpected, "Azure multipart upload not completed");

    // Create the target path
    if (auto ccode = endpoint.mapPath(entry.url(), m_targetObjectUrl))
        return ccode;

    // Add account name to the target path
    if (auto ccode = Url::toPath(m_targetObjectUrl, m_TargetObjectPath)) {
        return ccode;
    }

    auto errorOr = endpoint.processPath(PATH_PROCESSING_TYPE::CONTAINER_ONLY,
                                        m_TargetObjectPath,
                                        m_client.m_blobContainerClient);
    if (errorOr.hasCcode()) return errorOr.ccode();

    Text pathName = errorOr.value().gen();

    LOGT("Exporting object: {}", pathName);

    // get new blob client
    m_client.m_blobBlockClient.reset(new Azure::Storage::Blobs::BlockBlobClient(
        m_client.m_blobContainerClient->GetBlockBlobClient(pathName)));

    // clean the block ids
    m_blockIds.clear();

    // Multipart upload
    if (entry.size() > m_azureDefaultPartSize) {
        LOGT("Start multipart upload:", m_targetObjectUrl);

        // Calculate size of buffer for multipart upload
        m_azurePartSize =
            std::max(_cast<size_t>(std::floor(_cast<double>(entry.size()) /
                                              m_azureMaxPartNumber)),
                     _cast<size_t>(m_azureDefaultPartSize));
    }
    // Single part upload
    else {
        m_azurePartSize = m_azureDefaultPartSize;
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

    Error ccode = {};

    // Based on the tag type
    switch (pTag->tagId) {
        case TAG_OBJECT_METADATA::ID:
            // Process the metadata
            ccode = processMetadata(&pTagData->metadata);
            break;
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
Error IFilterInstance::close() noexcept {
    do {
        // Upload the latest data part if the object is ok
        if (!currentEntry->objectFailed() && m_targetObjectDataBuffer.size()) {
            std::vector<std::string> blockIds;

            auto copySize = m_targetObjectDataBuffer.size() - m_offset;

            Concurrency::streams::container_buffer<memory::Data<Byte>> sbuf(
                m_targetObjectDataBuffer, std::ios_base::in);

            // create Unique blockId
            Azure::Core::Uuid blockUuid = Azure::Core::Uuid::CreateUuid();
            std::string blockId =
                ap::crypto::base64Encode(blockUuid.ToString());

            // Upload the block.
            Azure::Core::IO::MemoryBodyStream m_Stream(m_targetObjectDataBuffer,
                                                       copySize);
            try {
                m_client.m_blobBlockClient->StageBlock(blockId, m_Stream);
            } catch (std::exception &e) {
                return MONERR(warning, Ec::Warning, "Could not upload",
                              e.what());
            }
            blockIds.push_back(blockId);
        }

        m_targetObjectDataBuffer.clear();
        // commit uploaded blocks
        if (auto ccode = callAndCatch(
                _location, "Checking for changes Azure object", [&]() {
                    m_client.m_blobBlockClient->CommitBlockList(m_blockIds);
                })) {
            return ccode;
        }

        // Set metadata
        if (auto ccode = setMetadata()) currentEntry->completionCode(ccode);

    } while (false);

    m_targetObjectDataBuffer.clear();
    m_azurePartSize = 0;

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
Error IFilterInstance::processObjectStreamData(
    const TAG_OBJECT_STREAM_DATA *pTag) noexcept {
    // Skip if object failed
    if (currentEntry->objectFailed()) return {};

    const Byte *data = _cast<const Byte *>(pTag->data.data);
    auto dataSize = pTag->size;

    while (dataSize > 0) {
        auto copySize = m_azurePartSize > dataSize ? dataSize : m_azurePartSize;

        m_targetObjectDataBuffer.append(data, copySize);
        data += copySize;
        dataSize -= _cast<Dword>(copySize);

        Concurrency::streams::container_buffer<memory::Data<Byte>> sbuf(
            m_targetObjectDataBuffer, std::ios_base::in);

        // create Unique blockId
        Azure::Core::Uuid blockUuid = Azure::Core::Uuid::CreateUuid();
        std::string blockId = ap::crypto::base64Encode(blockUuid.ToString());

        // Upload the block.
        Azure::Core::IO::MemoryBodyStream m_Stream(m_targetObjectDataBuffer,
                                                   copySize);
        if (auto ccode = callAndCatch(_location, "Upload the block", [&]() {
                m_client.m_blobBlockClient->StageBlock(blockId, m_Stream);
            })) {
            return ccode;
        }

        m_blockIds.push_back(blockId);
        m_offset += (int)copySize;
        m_targetObjectDataBuffer.clear();
    }

    // And done without error
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Processes the metadata saved with the object. Currently, just calls
///     the function to check if the corresponding objects exists on the cloud
///     and if it is new/older than the object in processing
///	@param[in]	pTag
///		The metadata tag
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::processMetadata(
    const TAG_OBJECT_METADATA *pTag) noexcept {
    Error ccode;

    m_setMetadata = true;

    // check if blob exists according to the `update` flag
    if ((ccode = isObjectUpdateNeeded()) || currentEntry->objectFailed()) {
        m_setMetadata = false;
        return ccode;
    }

    return {};
}

//-----------------------------------------------------------------------------
/// @details
///		Recover metadata using a current file
///	@returns
///		Error
//-----------------------------------------------------------------------------
Error IFilterInstance::setMetadata() noexcept {
    if (!m_setMetadata) return {};

    json::Value metadata;
#ifdef ROCKETRIDE_PLAT_MAC
    metadata["mtime"] = static_cast<unsigned long>(currentEntry->modifyTime());
#else
    metadata["mtime"] = currentEntry->modifyTime();
#endif
    Azure::Storage::Metadata metadataUpload;
    std::stringstream timeStringStream;
    timeStringStream << currentEntry->modifyTime();
    std::string timeString = timeStringStream.str();
    metadataUpload[metadataKey] = timeString;
    if (auto ccode = callAndCatch(_location, "Set MetaData", [&]() {
            m_client.m_blobBlockClient->SetMetadata(metadataUpload);
        })) {
        return ccode;
    }

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

    // get the filename
    std::shared_ptr<Azure::Storage::Blobs::BlobContainerClient>
        blobContainerClient;
    auto errorOr =
        endpoint.processPath(PATH_PROCESSING_TYPE::CONTAINER_ONLY,
                             m_TargetObjectPath, blobContainerClient);
    if (errorOr.hasCcode()) return {};
    Text pathName = errorOr.value().gen();

    if (auto ccode = callAndCatch(
            _location, "Checking for changes Azure object", [&]() -> Error {
                auto blob = blobContainerClient->GetBlobClient(pathName);

                Azure::Storage::Blobs::Models::BlobProperties blobValues;
                if (auto ccode = callAndCatch(
                        _location, "Checking for changes Azure object",
                        [&]() -> Error {
                            Azure::Response<
                                Azure::Storage::Blobs::Models::BlobProperties>
                                blobProperties = blob.GetProperties();
                            blobValues = blobProperties.Value;
                            return {};
                        })) {
                    LOGT("Blob does not exists", pathName);
                    return {};
                }

                // blob exist
                if (endpoint.config.exportUpdateBehavior ==
                    EXPORT_UPDATE_BEHAVIOR::SKIP) {
                    LOGT("Skipping existent blob", m_TargetObjectPath);
                    currentEntry->completionCode(
                        APERR(Ec::Skipped, "Skipping existent file"));
                    return {};
                }

                if (endpoint.config.exportUpdateBehavior ==
                    EXPORT_UPDATE_BEHAVIOR::UPDATE) {
                    const auto &metadata = blobValues.Metadata;
                    auto citer = metadata.find(metadataKey);

                    if (citer == metadata.cend()) {
                        LOGT("Metadata for Azure blob {} doesn't exist",
                             m_TargetObjectPath);
                        return {};
                    }

                    Text value = _ts(citer->second.c_str());
                    ErrorOr<json::Value> errorOrJson = _fd<json::Value>(value);
                    if (errorOrJson.hasCcode()) {
                        LOGT("Metadata for Azure blob", m_TargetObjectPath,
                             "isn't a valid JSON");
                        return {};
                    }

                    json::Value jsonMetadata = *errorOrJson;
                    if (jsonMetadata.isMember("mtime")) {
                        auto jsonMTime = jsonMetadata["mtime"];
                        if (jsonMTime.isIntegral() &&
                            jsonMTime.asInt64() == currentEntry->modifyTime()) {
                            LOGT("Azure blob", m_targetObjectDataBuffer,
                                 "has unchanged last modified time");
                            currentEntry->completionCode(
                                APERR(Ec::Skipped, "Timestamp the same:",
                                      currentEntry->modifyTime()));
                            return {};
                        }
                    }

                    LOGT("Azure blob", m_targetObjectDataBuffer,
                         "has either different last modified time, or is not "
                         "set");
                    return {};
                }

                return {};
            })) {
        return ccode;
    }
    return {};
}
}  // namespace engine::store::filter::azure
