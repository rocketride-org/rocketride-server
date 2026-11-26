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

#pragma once

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Stream begin
///
///		The TAG_OBJECT_STREAM_BEGIN/DATA/END define a generic data steam
///		class. Most filters and hosts will host their "generic" data
///		within these tags.
///
///		streamType:
///			This is the only ***required*** field
///
///		streamAttributes:
///			Only used if the metadata.flags specifies the WINSTREAM
///			flag. This comes from the BackupRead function. For
///			non-WINSTREAM sources, this can be 0.
///
///		streamSize:
///			Only used if the metadata.flags specifies the WINSTREAM
///			flag. This also comes from the BackupRead function. For
///			non-WINSTREAM sources, this can be 0.
///
///		streamOffset:
///			The offset within thre stream that this data should
///			be written. This is typically set to 0, however, in
///			the case of STREAM_BEGIN/SPARSE_DATA, we can specify
///			different offsets to write the following data at
///			different locations within a file.
///
///		These fields basically reproduce the WIN32_STREAM_ID header
///		for recovery using the BackupWrite API. The Windows file
///		system decides whether to recover data with BackupWrite
///		(if metadata.flags & WINSTREAM is set) or WriteFile.
///		Since a Linux source, or a non-file system node
///		will not set metadata.flags = WINSTREAM, the fields are
///		ignored attributes and size are ignored and should be set
///		to 0.
///
//-------------------------------------------------------------------------
struct TAG_OBJECT_STREAM_BEGIN : TAG {
public:
    //-----------------------------------------------------------------
    /// @details
    ///		Stream types - these pretty much follow the windows stream
    ///		types from WIN32_STREAM_ID although others can be added
    ///		as needed. Most endpoints only pay attention to STREAM_DATA
    //-----------------------------------------------------------------
    enum STREAM_TYPE : Dword {
        STREAM_DATA = 0x00000001,
        STREAM_EA_DATA = 0x00000002,
        STREAM_SECURITY_DATA = 0x00000003,
        STREAM_ALTERNATE_DATA = 0x00000004,
        STREAM_LINK = 0x00000005,
        STREAM_OBJECT_ID = 0x00000007,
        STREAM_REPARSE_DATA = 0x00000008,
        STREAM_SPARSE_BLOCK = 0x00000009,
        STREAM_TXFS_DATA = 0x0000000A,
        STREAM_GHOSTED_FILE_EXTENTS = 0x0000000B
    };

    //-----------------------------------------------------------------
    /// @details
    ///		Define the constant ID
    //-----------------------------------------------------------------
    _const auto ID = TAG_ID::SBGN;

    //-----------------------------------------------------------------
    /// @details
    ///		Define the data for the tag
    //-----------------------------------------------------------------
    struct DATA {
        //-------------------------------------------------------------
        /// @details
        ///		Type of the stream
        //-------------------------------------------------------------
        STREAM_TYPE streamType = STREAM_TYPE::STREAM_DATA;

        //-------------------------------------------------------------
        /// @details
        ///		Attributes of the stream - windows only, set to 0
        //		on non-windows systems
        //-------------------------------------------------------------
        Dword streamAttributes = 0;

        //-------------------------------------------------------------
        /// @details
        ///		Size of the stream of data
        ///		This is basically only for Windows where we are using
        ///		the BackupRead/Write interface - it can be set to
        //		0 on non-windows system since we will use direct
        //		file i/o to recover the file
        //-------------------------------------------------------------
        Qword streamSize = 0;

        //-------------------------------------------------------------
        /// @details
        ///		Offset of the stream of data
        ///		This indicates where the data should be located within
        ///		an object
        //-------------------------------------------------------------
        Qword streamOffset = 0;

        //-------------------------------------------------------------
        /// @details
        ///		The string with JSON encoding
        //-------------------------------------------------------------
        TextChr streamName[1] = {0};
    };

    //-----------------------------------------------------------------
    /// @details
    ///		Declare the data for the tag
    //-----------------------------------------------------------------
    DATA data;

    //-----------------------------------------------------------------
    /// @details
    ///		Set the stream name
    //-----------------------------------------------------------------
    auto setStreamName(Text *pValue) {
        const auto pString = pValue->c_str();
        Txtcpy(data.streamName, MAX_IOSIZE, pString);

        const auto nameSize = (Dword)pValue->size();
        setPayloadSize(offsetof(DATA, streamName) + nameSize + 1);
        return this;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Set the stream size
    //-----------------------------------------------------------------
    auto setStreamSize(Qword streamSize) {
        data.streamSize = streamSize;
        return this;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Set the stream offset
    //-----------------------------------------------------------------
    auto setStreamOffset(Qword streamOffset) {
        data.streamOffset = streamOffset;
        return this;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Build the tag
    //-----------------------------------------------------------------
    static auto build(void *pBuffer,
                      STREAM_TYPE streamType = STREAM_TYPE::STREAM_DATA,
                      Dword streamAttributes = 0, Text *pStreamName = nullptr) {
        static Text empty;

        // Given a generic memory block, cast over to the appropriate type
        auto *pTag = (TAG_OBJECT_STREAM_BEGIN *)pBuffer;

        // Set it up
        TAG::build(pTag, ID, sizeof(DATA));
        pTag->data.streamType = streamType;
        pTag->data.streamAttributes = streamAttributes;
        pTag->data.streamSize = 0;
        pTag->data.streamOffset = 0;

        if (!pStreamName) pStreamName = &empty;

        pTag->setStreamName(pStreamName);

        // And return it so we can chain
        return pTag;
    }

private:
    //-----------------------------------------------------------------
    /// @details
    ///		The constructor is deleted. We cannot build this
    ///		with a declaration since this is dynamic
    //-----------------------------------------------------------------
    TAG_OBJECT_STREAM_BEGIN() = delete;
};
}  // namespace engine::store
