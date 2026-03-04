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

namespace engine::store::filter::zip {
//-------------------------------------------------------------------------
/// @details
///		Open up the substream
///	@param[in]	entry
///		The object info from the input pipe
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::open(Entry &entry) noexcept {
    Error ccode;

    // Create the target path
    if (ccode = endpoint.mapPath(entry.url(), m_targetObjectUrl)) return ccode;

    // Open a new subobject on the stream
    if (ccode = global.m_stream->openSubStream(entry, m_targetObjectUrl,
                                               m_pContext))
        return ccode;

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Processes the data within the stream
///	@param[in]	pTag
///		The stream data tag
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::processStreamData(
    TAG_OBJECT_STREAM_DATA *pTag) noexcept {
    // Setup the input data to send
    InputData data = InputData{pTag->data.data, pTag->size};

    if (auto ccode = global.m_stream->tryWriteSubStream(m_pContext, data))
        return ccode;

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
    Error ccode;

    // Switch it to generic format so we can read the
    // data values from it
    TAGS *pTagData = (TAGS *)pTag;

    // Based on the tag type
    switch (pTag->tagId) {
        case TAG_OBJECT_STREAM_BEGIN::ID: {
            // Begin a new stream within the object
            m_isPrimary =
                isPrimaryDataStream((TAG_OBJECT_STREAM_BEGIN *)(pTag));
            break;
        }

        case TAG_OBJECT_STREAM_DATA::ID: {
            // Write stream data
            if (m_isPrimary) ccode = processStreamData(&pTagData->streamData);
            break;
        }

        case TAG_OBJECT_STREAM_END::ID: {
            m_isPrimary = false;
            break;
        }
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
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::close() noexcept {
    Error ccode;

    // Close this substream
    if (ccode = global.m_stream->tryCloseSubStream(m_pContext)) return ccode;

    return ccode;
}
}  // namespace engine::store::filter::zip
