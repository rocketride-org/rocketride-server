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

namespace engine::test {
//=========================================================================
// Low level API
//=========================================================================

//-------------------------------------------------------------------------
/// @details
///		Given a filter name, this function will instantiate the filter,
///		and prepare it accept commands.
//-------------------------------------------------------------------------
Error IFilterTest::connect(
    OPEN_MODE openMode /* = OPEN_MODE::TARGET */) noexcept {
    // Generic json config file which we will add the specific
    // filter to in the pipeline section
    auto task = R"(
				{
					"config": {
						"keystore": "kvsfile://data/keystore.json",
						"service": {
							"filters": [],
							"key": "null://Null",
							"name": "Null endpoint",
							"type": "null",
							"mode": "target",
							"parameters": {}
                        }
					},
                    "taskId": "5de21787-1b81-44da-a5e5-eb64e9a49830",
                    "nodeId": "fa880af7-0299-471a-aa92-dca1062f1f7d"
				}
			)"_json;

    // Merge in the caller specified config passed during
    // construction of this filter
    if (m_config.type() != json::ValueType::nullValue) task.merge(m_config);

    // Now, add the desired filters into the pipeline
    bool isTargetMode = openMode == OPEN_MODE::TARGET;
    if (!isTargetMode) task["config"]["service"]["mode"] = "source";

    if (!isTargetMode) task["config"]["service"]["filters"].append("null");
    for (auto &filter : m_filters) {
        task["config"]["service"]["filters"].append(filter);
    }

    // Get an endpoint
    if (isTargetMode) {
        auto endpoint = IServiceEndpoint::getTargetEndpoint(
            {.jobConfig = task,
             .taskConfig = task["config"],
             .serviceConfig = task["config"]["service"],
             .openMode = OPEN_MODE::TARGET});

        // Check for error
        if (!endpoint) return endpoint.ccode();

        // Allocate a block of memory
        if (auto ccode = Memory::alloc(MAX_TAGSIZE, &m_pBuffer)) return ccode;

        // Save the endpoint
        m_endpoint = _mv(*endpoint);

        // finished TARGET mode
        return {};
    }

    auto endpoint = IServiceEndpoint::getSourceEndpoint(
        {.jobConfig = task,
         .taskConfig = task["config"],
         .serviceConfig = task["config"]["service"],
         .openMode = OPEN_MODE::SOURCE});

    // Check for error
    if (!endpoint) return endpoint.ccode();

    // Allocate a block of memory
    if (auto ccode = Memory::alloc(MAX_TAGSIZE, &m_pBuffer)) return ccode;

    // Save the endpoint
    m_endpoint = *endpoint;

    // finished TARGET mode
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Gets a pipe from the endpoint
//-------------------------------------------------------------------------
ErrorOr<ServicePipe> IFilterTest::getPipe() noexcept {
    // Get a pipe
    return m_endpoint->getPipe();
}

//-------------------------------------------------------------------------
/// @details
///		Allocate a pipe, open an object.
///		This is a combination of functions to make it easy
///		for testers to set things up
///	@param[in] name
///		Name of the entry (could be a text path as well)
//-------------------------------------------------------------------------
ErrorOr<ServicePipe> IFilterTest::openObjectSimple(TextView name,
                                                   uint32_t flags) noexcept {
    // Get a dummy entry
    auto entry = getDummyEntry(name);
    entry.flags(flags);

    // Save it - we need it to persist because we are passing around refs
    m_entry = entry;

    // Get the pipe - return the error if we couldn't
    auto pipe = getPipe();
    if (!pipe) return pipe;

    // Open the object
    if (auto ccode = pipe->open(m_entry)) return ccode;

    // Return the pipe
    return pipe;
}

//-------------------------------------------------------------------------
/// @details
///		Executes openObjectSimple to open a pipe, and send a begin object
///     if success. Returns a pipe. This is a combination of functions to
///     make it easy for testers to set things up
///	@param[in] name
///		Name of the entry (could be a text path as well)
//-------------------------------------------------------------------------
ErrorOr<ServicePipe> IFilterTest::openObject(TextView name,
                                             uint32_t flags) noexcept {
    //
    auto pipe = openObjectSimple(name, flags);
    if (!pipe) return pipe;

    // Send the begin sequence
    if (auto ccode = writeTagBeginObject(*pipe, m_entry)) return ccode;

    // Return the pipe
    return pipe;
}

//-------------------------------------------------------------------------
/// @details
///		Build a dummy entry
///	@param[in] name
///		Name of the entry (could be a text path as well)
//-------------------------------------------------------------------------
Entry IFilterTest::getDummyEntry(TextView name) {
    // Build the url
    Url url;
    if (auto ccode = Url::toUrl(m_endpoint->config.logicalType, name, url))
        throw ccode;

    // Build the entry
    Entry entry(url);

    // Will have these - not that if these change, you must update
    // the encryption values in the encryption test
    entry.objectId("obj1");
    entry.version(1);

    // Set the basic dimensions
    entry.flags(0);
    entry.attrib(0);
    entry.size(42);
    entry.storeSize(0);
    entry.createTime(1633452260);
    entry.modifyTime(1633452261);
#if ROCKETRIDE_PLAT_UNX
    entry.changeTime(1633452261);
#endif
    entry.accessTime(1633452262);

    // Dummy signature
    Text componentId =
        "fe3d866b27df4d6da5b5f6dc3340dd08bf76c99cc36cd0b5fdcc682084017f20484c6d"
        "9ce2a66a6d3a08ed55f681c2ae44fe83bfe57e7e30e7f871b9a793b6b1";
    entry.componentId(componentId);

    // If may have an instance id
    entry.instanceId(2);
    entry.wordBatchId(3);
    return entry;
}

//-------------------------------------------------------------------------
/// @details
///		Sends the begin object sequence of tags
///	@param[in] pipe
///		The target pipe to send it to
///	@param[in] entry
///		The enty information to send
//-------------------------------------------------------------------------
Error IFilterTest::writeTagBeginObject(ServicePipe pipe,
                                       Entry &entry) noexcept {
    // Write the object begin tag
    const auto objectBegin = localfcn()->Error {
        // Write an object begin
        auto objectBegin = TAG_OBJECT_BEGIN();
        objectBegin.setAttributes(TAG_ATTRIBUTES::INSTANCE_DATA);

        return pipe->writeTag(&objectBegin);
    };

    // Write the metadata tag
    const auto objectMetadata = localfcn()->Error {
        // Absolutely minimal set
        json::Value data;
        data["flags"] = 0;
        data["url"] = (TextView)entry.url();

        // Stringify the json object
        auto metadataString = data.stringify(true);

        // Build the tag
        const auto pMetadata =
            TAG_OBJECT_METADATA::build(m_pBuffer, &metadataString)
                ->setAttributes(TAG_ATTRIBUTES::INSTANCE_DATA);

        // Write it out
        return pipe->writeTag(pMetadata);
    };

    // Send the begin tag
    if (auto ccode = objectBegin()) return ccode;

    if (!(m_filterFlags & FILTER_TEST_FLAGS::SKIP_METADATA)) {
        // Send the metadata tag
        if (auto ccode = objectMetadata()) return ccode;
    }

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Sends the end object sequence of tags
///	@param[in] pipe
///		The target pipe to send it to
//-------------------------------------------------------------------------
Error IFilterTest::writeTagBeginStream(
    ServicePipe pipe, TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE streamType,
    Dword streamAttributes, Dword streamSize, Qword streamOffset,
    Text streamName) noexcept {
    if (m_filterFlags & FILTER_TEST_FLAGS::SKIP_BEGINSTREAM) return {};

    // Grab the suff we need out of the header
    // Setup the default stream begin tag
    const auto pStreamBeginTag = TAG_OBJECT_STREAM_BEGIN::build(
        m_pBuffer, streamType, streamAttributes, &streamName);

    // Save the size and offset
    pStreamBeginTag->data.streamSize = streamSize;
    pStreamBeginTag->data.streamOffset = streamOffset;

    // Write it
    return pipe->writeTag(pStreamBeginTag);
}

//-------------------------------------------------------------------------
/// @details
///		Sends the end object sequence of tags
///	@param[in] pipe
///		The target pipe to send it to
//-------------------------------------------------------------------------
Error IFilterTest::writeTagData(ServicePipe pipe, size_t size,
                                const void *pData) noexcept {
    size_t offset = 0;
    while (size) {
        // Determine how much we can send
        auto chunk = size;
        if (chunk > MAX_IOSIZE) chunk = MAX_IOSIZE;

        // Get a generic ptr
        Byte *pSendBuffer = (Byte *)pData;

        // Build the tag
        const auto pDataTag = TAG_OBJECT_STREAM_DATA::build(m_pBuffer);

        // Save the tag data
        memcpy(pDataTag->data.data, &pSendBuffer[offset], chunk);

        // Set the data size
        pDataTag->setDataSize((Dword)chunk);

        // Write it
        if (auto ccode = pipe->writeTag(pDataTag)) return ccode;

        // Update the positions
        offset += chunk;
        size -= chunk;
    }

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Sends the end object sequence of tags
///	@param[in] pipe
///		The target pipe to send it to
//-------------------------------------------------------------------------
Error IFilterTest::writeTagEndStream(ServicePipe pipe) noexcept {
    // Create the tag
    const auto streamEndTag = TAG_OBJECT_STREAM_END();

    // Write the stream end tag
    return pipe->writeTag(&streamEndTag);
};

//-------------------------------------------------------------------------
/// @details
///		Sends the end object sequence of tags
///	@param[in] pipe
///		The target pipe to send it to
//-------------------------------------------------------------------------
Error IFilterTest::writeTagEndObject(ServicePipe pipe) noexcept {
    // Write the object end tag
    const auto objectEnd = localfcn()->Error {
        Error completionCode{};

        // Write an object end
        auto objectEnd = TAG_OBJECT_END(completionCode);
        objectEnd.setAttributes(TAG_ATTRIBUTES::INSTANCE_DATA);

        return pipe->writeTag(&objectEnd);
    };

    if (auto ccode = objectEnd()) return ccode;

    // Done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Closes the object on a pipe and releases the pipe
///	@param[in] pipe
///		The pipe to release
//-------------------------------------------------------------------------
Error IFilterTest::closeObjectSimple(ServicePipe pipe) noexcept {
    // Close the object on the pipe
    if (auto ccode = pipe->close()) return ccode;

    // Release the pipe
    m_endpoint->putPipe(pipe);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Sends object end, and calls closeObjectSimple
///	@param[in] pipe
///		The pipe to release
//-------------------------------------------------------------------------
Error IFilterTest::closeObject(ServicePipe pipe) noexcept {
    // Send the end sequence
    if (auto ccode = writeTagEndObject(pipe)) return ccode;

    return closeObjectSimple(pipe);
}

//-------------------------------------------------------------------------
/// @details
///		Releases a pipe back to the endpoint
///	@param[in] pipe
///		The pipe to release
//-------------------------------------------------------------------------
Error IFilterTest::putPipe(ServicePipe pipe) noexcept {
    m_endpoint->putPipe(pipe);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This function will disconnect and destory the filter. The
///		destructor does this automatically
//-------------------------------------------------------------------------
Error IFilterTest::disconnect() noexcept {
    Error ccode;

    // Release the endpoint if we have it
    if (m_endpoint) {
        ccode = m_endpoint->endEndpoint();
        m_endpoint = {};
    }

    // Release the memory
    if (m_pBuffer) Memory::release(&m_pBuffer);

    return ccode;
}

//=========================================================================
// High level API
//=========================================================================

//-------------------------------------------------------------------------
/// @details
///		Sends the data through the tag system
///	@param[in]	file
///		The name of the file to send (doesn't have to exist)
///	@param[in]	size
///		Size of the data to send
///	@param[in]	pData
///		Ptr to the data to send
///	@param[in]	flags
///		Object flags to control processing
//-------------------------------------------------------------------------
Error IFilterTest::writeTagData(TextView file, size_t size, const void *pData,
                                uint32_t flags) noexcept {
    // Connect the filters
    if (auto ccode = connect()) return ccode;

    // Get a source pipe, open a dummy object on it
    auto pipe = openObject(file, flags);
    if (!pipe) return pipe.ccode();

    // Pass the text through the tag system to the parser
    if (auto ccode = writeTagBeginStream(*pipe)) return ccode;
    // Send the data
    if (auto ccode = writeTagData(*pipe, size, pData)) return ccode;
    // Send the end stream marker
    if (auto ccode = writeTagEndStream(*pipe)) return ccode;

    // Close it
    if (auto ccode = closeObject(*pipe)) return ccode;

    // Disconnect the filters
    disconnect();
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Sends the data to the filter stack
///	@param[in]	file
///		The name of the file to send (doesn't have to exist)
///	@param[in]	data
///		Data to send
///	@param[in]	flags
///		Object flags to control processing
//-------------------------------------------------------------------------
Error IFilterTest::writeTagData(TextView file, OutputData data,
                                uint32_t flags) noexcept {
    return writeTagData(file, data.size(), data.data(), flags);
}

//-------------------------------------------------------------------------
/// @details
///		Sends the text to the filter stack
///	@param[in]	file
///		The name of the file to send (doesn't have to exist)
///	@param[in]	text
///		Text to send
///	@param[in]	flags
///		Object flags to control processing
//-------------------------------------------------------------------------
Error IFilterTest::writeTagData(TextView file, TextView text,
                                uint32_t flags) noexcept {
    return writeTagData(file, text.size(), text.data(), flags);
}

//-------------------------------------------------------------------------
/// @details
///		Sends the list of the text items to the filter stack
///	@param[in]	file
///		The name of the file to send (doesn't have to exist)
///	@param[in]	text
///		Text items to send
///	@param[in]	flags
///		Object flags to control processing
//-------------------------------------------------------------------------
Error IFilterTest::writeTagData(TextView file,
                                std::initializer_list<TextView> text,
                                uint32_t flags) noexcept {
    // Connect the filters
    if (auto ccode = connect()) return ccode;

    // Get a source pipe, open a dummy object on it
    auto pipe = openObject(file, flags);
    if (!pipe) return pipe.ccode();

    // Pass the text through the tag system to the parser
    if (auto ccode = writeTagBeginStream(*pipe)) return ccode;
    // Send the data
    for (const auto &textPart : text) {
        if (auto ccode = writeTagData(*pipe, textPart.size(), textPart.data()))
            return ccode;
    }
    // Send the end stream marker
    if (auto ccode = writeTagEndStream(*pipe)) return ccode;

    // Close it
    if (auto ccode = closeObject(*pipe)) return ccode;

    // Disconnect the filters
    disconnect();
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Sends the text to the filter stack
///	@param[in]	file
///		The name of the file to send (doesn't have to exist)
///	@param[in]	text
///		Text to send
///	@param[in]	flags
///		Object flags to control processing
//-------------------------------------------------------------------------
Error IFilterTest::writeTagData(TextView file, Utf16View text,
                                uint32_t flags) noexcept {
    return writeTagData(file, text.size(), text.data(), flags);
}

//-------------------------------------------------------------------------
/// @details
///		Sends the text to the filter stack
///	@param[in]	file
///		The name of the file to send (doesn't have to exist)
///	@param[in]	text
///		Text to send
///	@param[in]	flags
///		Object flags to control processing
//-------------------------------------------------------------------------
Error IFilterTest::writeTagData(TextView file, const char8_t *pText,
                                uint32_t flags) noexcept {
    return writeTagData(file, Utf8len(pText), pText, flags);
}

//-------------------------------------------------------------------------
/// @details
///		Sends the file, usually from the testdata dir to pipe. This
///		encompasses the entire sequence, so you just have to create the
///		endpoint, send a file and then close the endpoint
///	@param[in]	file
///		The file to send
//-------------------------------------------------------------------------
Error IFilterTest::sendFile(TextView file, uint32_t flags) noexcept {
    // Build the path
    file::Path path = datasetsPath() / file;

    // Use the put API to store the file on the target and validate
    ErrorOr<Buffer> content = file::fetch(path);
    if (!content) return content.ccode();

    // Send the data
    return writeTagData(file, content->size(), (const void *)content->data(),
                        flags);
}

//-------------------------------------------------------------------------
/// @details
///		Sends the given Utf16 text through the writeText interface
///	@param[in]	file
///		The name of the file to send (doesn't have to exist)
///	@param[in]	size
///		Size of the data to send
///	@param[in]	pData
///		Ptr to the data to send
///	@param[in]	flags
///		Object flags to control processing
//-------------------------------------------------------------------------
Error IFilterTest::sendText(TextView file, Utf16View text,
                            uint32_t flags) noexcept {
    // Connect the filters
    if (auto ccode = connect()) return ccode;

    // Get a source pipe, open a dummy object on it
    auto pipe = openObject(file, flags);
    if (!pipe) return pipe.ccode();

    // Pass the text directly on the writeText interface
    if (auto ccode = pipe->writeText(text)) return ccode;

    // Close it
    if (auto ccode = closeObject(*pipe)) return ccode;

    // Disconnect the filters
    disconnect();
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Get the built in tag buffer - allocated only when needed
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterTest::getTagBuffer(TAG **ppTag) noexcept {
    // If it is not there, allocate it
    if (!m_pTagBuffer) {
        // Allocate it now
        if (auto ccode = Memory::alloc(MAX_TAGSIZE, &m_pTagBuffer))
            return ccode;
    }

    // Return it
    *ppTag = m_pTagBuffer;
    return {};
}
}  // namespace engine::test
