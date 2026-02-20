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
//	Declares the object for working with Ms Email.
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::sharepoint {
using namespace utility;

//-------------------------------------------------------------------------
/// @details
///		Begins operations on this filter. Sets up commonly used members
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::beginFilterInstance() noexcept {
    return Parent::beginFilterInstance();
}

//-------------------------------------------------------------------------
/// @details
///		Destructor - ends the endpoint. We need to do this here since, if
///		we just let the IServiceEndpoint do it, it will only clean up
///		itself, not our allocations
//-------------------------------------------------------------------------
IFilterEndpoint::~IFilterEndpoint() { endEndpoint(); };

//-------------------------------------------------------------------------
/// @details
///		Begins operations on this filter. Sets up commonly used members
///	@param[in]	openMode
///		Mode that endpoint is opened in
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterEndpoint::beginEndpoint(OPEN_MODE openMode_) noexcept {
    LOGT("Creating {} endpoint", Type);

    // Call the parent first so open mode is set
    if (auto ccode = Parent::beginEndpoint(openMode_)) return ccode;

    // Returns if processing "deleted" resource
    // Prevents connection to the deleted resource which might not be available
    // at all
    bool deleted = config.serviceConfig.lookup<bool>("deleted");
    if (deleted) return {};

    // Do not call beginEndpoint/endEndpoint for commitScan
    if (config.jobConfig["type"].asString() != task::commitScan::Task::Type) {
        auto ccode = createClient();
        if (ccode.hasCcode()) return ccode.ccode();

        m_msSharepointNode = ccode.value();
    }
    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function is called as one of the last steps in
///     construction of the endpoint. We will use it to parse
///     the email information
///	@param[in]	jobConfig
///		The full job config
///	@param[in]	taskConfig
///		The task info
///	@param[in]	serviceConfig
///		The service config
///	@returns
///		Error
//-----------------------------------------------------------------
Error IFilterEndpoint::setConfig(const json::Value &jobConfig,
                                 const json::Value &taskConfig,
                                 const json::Value &serviceConfig) noexcept {
    // Let the parent decode everything first
    if (auto ccode = Parent::setConfig(jobConfig, taskConfig, serviceConfig))
        return ccode;

    // Then parse the bucket out
    if (auto ccode = SharePointCppConfig::__fromJson(config, m_msConfig))
        return ccode;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		end the endpoint operation
//-------------------------------------------------------------------------
Error IFilterEndpoint::endEndpoint() noexcept {
    // And call the parent
    if (auto ccode = Parent::endEndpoint()) return ccode;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		end the endpoint operation
//-------------------------------------------------------------------------
ErrorOr<std::shared_ptr<MsSharepointNode>>
IFilterEndpoint::createClient() noexcept {
    // Start the endpoint
    std::shared_ptr<MsSharepointNode> msSharepointNode(
        new MsSharepointNode(m_msConfig));

    // Parse it and get the keys, bucket, etc
    auto ccode = msSharepointNode->createConnection();
    if (ccode) return ccode;
    return msSharepointNode;
}

//-----------------------------------------------------------------
/// @details
///		Make static, finalized configs
//-----------------------------------------------------------------
Error IFilterEndpoint::getConfigSubKey(Text &key) noexcept {
    if (config.serviceMode == SERVICE_MODE::SOURCE) {
        key = _ts(m_msConfig->m_tenantId);
    } else {
        key = _ts(m_msConfig->m_tenantId, "/", config.storePath);
    }
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Get targetsiteId, if not present then get siteid
//-----------------------------------------------------------------
ErrorOr<Text> IFilterEndpoint::getTargetSiteId(const Text &siteName) noexcept {
    if (targetSiteId.empty()) {
        auto ccode = m_msSharepointNode->getSiteId(siteName);
        if (ccode.hasCcode()) return ccode.ccode();
        targetSiteId = ccode.value();
    }
    return targetSiteId;
}
//-------------------------------------------------------------------------
/// @details
///		create client for connection to sharepoint
//-------------------------------------------------------------------------
Error IFilterInstance::getClient() noexcept {
    // Start the endpoint
    // Parse it and get the keys, bucket, etc
    auto ccode = endpoint.createClient();
    if (ccode.hasCcode()) return ccode.ccode();

    m_msSharepointNode = ccode.value();

    return {};
}

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

    LOGT("Rendering Sharepoint object {}", object);

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
    LOGT("Rendering Sharepoint object {}", object.fileName());
    Error ccode;
    auto start = time::now();

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if (ccode = getTagBuffer(&pTagBuffer)) return ccode;

    LOGT("Rendering metadata for", object.fileName());

    // Store file metadata
    if (ccode = sendTagMetadata(target, object)) {
        object.completionCode(ccode);
        return {};
    }

    LOGT("Rendering begin stream for Sharepoint object {}", object.fileName());
    if (ccode = sendTagBeginStream(target, m_pTagBuffer, object)) {
        return ccode;
    }

    auto size = object.size();
    m_msSharepointNode->clearSizes();
    m_msSharepointNode->setTotalSize(size);

    auto downloadCcode = m_msSharepointNode->getDownloadUrl(object);
    if (downloadCcode.hasCcode()) {
        object.completionCode(downloadCcode.ccode());
        return {};
    }
    Text downloadUrl = downloadCcode.value();

    while (size) {
        // Read the data
        auto data = m_msSharepointNode->downloadInChunksFile(downloadUrl);
        if (data.hasCcode()) {
            object.completionCode(data.ccode());
            return {};
        }

        if (!data.hasValue()) {
            object.completionCode(APERR(Ec::NotFound, "Item not found"));
            return {};
        }
        auto &dataVec = data.value();
        auto const dataVa = dataVec.size();

        size_t dataSize = dataVa;
        size_t offset = 0;
        while (dataSize) {
            auto sizeToRead = dataSize > MAX_IOSIZE ? MAX_IOSIZE : dataSize;
            // Build the tag
            const auto pDataTag = TAG_OBJECT_STREAM_DATA::build(m_pTagBuffer);
            auto dataBuffer = OutputData(pDataTag->data.data, sizeToRead);
            unsigned char *ptr = dataBuffer.template cast<unsigned char>();
            std::copy(dataVec.begin() + offset,
                      dataVec.begin() + offset + sizeToRead, ptr);

            // Indicate end of TAG buffer
            pDataTag->setDataSize(_cast<Dword>(sizeToRead));

            // Write the data stream
            if (ccode = pDown->sendTag(target, pDataTag)) return ccode;

            dataSize -= sizeToRead;
            offset += sizeToRead;
        }
        size -= dataVa;
    }

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
    if (ccode = getTagBuffer(&pTagBuffer)) return ccode;

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
///		Checks if an object has been deleted
///	@param[inout] object
///		The entry to update
///	@returns
///		Error
//-------------------------------------------------------------------------
ErrorOr<bool> IFilterInstance::stat(Entry &object) noexcept {
    auto fullPath = object.uniqueUrl().path();
    Text siteId = fullPath.at(0);
    Text driveId = fullPath.at(DRIVE_POS);
    if (auto ccode = getClient()) {
        return true;
    }

    auto pathDetails =
        m_msSharepointNode->getItemPath(siteId, driveId, object.uniqueName());
    if (pathDetails.hasCcode() || !pathDetails.hasValue()) return true;

    Text pathValue = pathDetails.value();
    // get sitename
    Text siteName = object.url().path().at(0);
    Text actualPath = siteName + pathValue + "/" + object.name();

    // return false in case of match
    return !(0 == Utf8icmp(object.path(), actualPath));
}

}  // namespace engine::store::filter::sharepoint