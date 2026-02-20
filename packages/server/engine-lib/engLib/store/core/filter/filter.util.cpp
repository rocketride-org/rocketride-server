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

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Bind linkages - used to bind up the relationships of the filters
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceFilterInstance::bindLinkages(
    size_t pipeId_, size_t filterLevel_, ServiceInstance filterDown_) noexcept {
    this->pipeId = pipeId_;
    this->filterLevel = filterLevel_;
    this->pDown = filterDown_;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Get the built in tag buffer - allocated only when needed
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceFilterInstance::getTagBuffer(TAG **ppTag) noexcept {
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

//-------------------------------------------------------------------------
/// @details
///		Get the built in IO buffer - allocated only when needed
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceFilterInstance::getIOBuffer(IOBuffer **ppIOBuffer) noexcept {
    // If it is not there, allocate it
    if (!m_pIOBuffer) {
        // Allocate it now
        if (auto ccode = Memory::alloc(
                offsetof(IOBuffer, data) + endpoint->config.segmentSize,
                &m_pIOBuffer))
            return ccode;
    }

    // Return it
    *ppIOBuffer = m_pIOBuffer;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This function will easily determine if this stream represents a
///		primary data stream. If the stream is named, or if is not
///		stream data, returns false
///	@param[in]	pTag
///		The object stream begin tag to check
//-------------------------------------------------------------------------
bool IServiceFilterInstance::isPrimaryDataStream(
    TAG_OBJECT_STREAM_BEGIN *pTag) noexcept {
    // Get the name of this stream
    Text streamName = Text(pTag->data.streamName);

    // If this is the named, can't be the primary stream
    if (streamName.length()) return false;

    // If it is the unnamed STREAM_DATA, it is primary
    if (pTag->data.streamType ==
        TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_DATA)
        return true;

    // If it is the unnamed STREAM_SPARSE_BLOCK, it is primary
    if (pTag->data.streamType ==
        TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_SPARSE_BLOCK)
        return true;

    // It is something else
    return false;
}
}  // namespace engine::store
