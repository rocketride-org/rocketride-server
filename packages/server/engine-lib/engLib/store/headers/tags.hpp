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
// Tag definitions - pack all tag structures as they are stored
// and need to be cross platform
#pragma pack(push, 1)

// Use the common string definition
#define TAG_DEFINE(str) STR_DEFINE(str)

// Contained in the signature field
#define TAG_SIG TAG_DEFINE("TAG-")

// This is the size of all tags
#define TAG_HEADER_SIZE (sizeof(TAG))
#define TAG_PAYLOAD_SIZE(pTag) (pTag->size)
#define TAG_TOTAL_SIZE(pTag) (sizeof(TAG) + pTag->size)

//-----------------------------------------------------------------------------
/// @details
///		Tag ids when viewed as binary ascii show up with the characters
///		matching their id enumeration, we use enums so that during debugging
///		we can also see the tag without casting to binary again to see the
///		text.
//-----------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(
    TAG_ID, 0, 20, INVALID = 0,
    OBEG =
        TAG_DEFINE("OBEG"),     //	TAG_OBJECT_BEGIN				Begin an object
    OMET = TAG_DEFINE("OMET"),  //		TAG_OBJECT_METADATA				String:
                                // JSON encoded metadata
    OENC = TAG_DEFINE("OENC"),  //		TAG_OBJECT_STREAM_ENCRYPTED		Blob: OS
                                // encrypted binary data
    SBGN = TAG_DEFINE("SBGN"),  //		TAG_OBJECT_STREAM				Dword,
                                // String: Stream type and name
    SDAT = TAG_DEFINE(
        "SDAT"),  //		TAG_OBJECT_STREAM_DATA			Blob: Binary data
    SEND =
        TAG_DEFINE("SEND"),     //		TAG_OBJECT_STREAM_END			End a stream
    OSIG = TAG_DEFINE("OSIG"),  //		TAG_OBJECT_SIGNATURE			String:
                                // Object signature (sha512 hash)
    OEND = TAG_DEFINE(
        "OEND"),                //	TAG_OBJECT_END						End an object,
    ENCK = TAG_DEFINE("ENCK"),  //	TAG_ENCRYPTION_KEY				String:
                                // Encryption key name
    ENCR =
        TAG_DEFINE("ENCR"),  //	TAG_ENCRYPTED					Encrypted tag
    CMPR =
        TAG_DEFINE("CMPR"),    //	TAG_COMPRESSED					Compressed tag
    HASH = TAG_DEFINE("HASH")  //	TAG_HASH						Hash tag
);

//-----------------------------------------------------------------------------
/// @details
///		Define attributes for the tags
//-----------------------------------------------------------------------------
enum TAG_ATTRIBUTES : Dword {
    NO_COMPRESSION = BIT(0),  // Source suggests not to compress this
    NO_ENCRYPTION = BIT(1),   // Source suggests not to encrypt this
    NO_COPY = BIT(2),         // On a copy TAG <=> TAG, do not copy this tag
    INSTANCE_DATA = BIT(3)    // Tag represents instance specific data
};
}  // namespace engine::store

#include "./tags/TAG.hpp"
#include "./tags/TAG_DATA.hpp"
#include "./tags/TAG_VALUE_STRING.hpp"
#include "./tags/TAG_VALUE_DATA.hpp"
#include "./tags/TAG_OBJECT_BEGIN.hpp"
#include "./tags/TAG_OBJECT_METADATA.hpp"
#include "./tags/TAG_OBJECT_STREAM_BEGIN.hpp"
#include "./tags/TAG_OBJECT_STREAM_DATA.hpp"
#include "./tags/TAG_OBJECT_STREAM_END.hpp"
#include "./tags/TAG_OBJECT_STREAM_ENCRYPTED.hpp"
#include "./tags/TAG_OBJECT_END.hpp"
#include "./tags/TAG_ENCRYPTION_KEY.hpp"
#include "./tags/TAG_ENCRYPTED.hpp"
#include "./tags/TAG_COMPRESSED.hpp"
#include "./tags/TAG_HASH.hpp"

namespace engine::store {
static_assert(sizeof(TAG_ID) == sizeof(Dword),
              "TAG_ID must be same size as Dword");
static_assert(sizeof(TAG) == 16, "TAG header is not 16 bytes");

//-----------------------------------------------------------------------------
/// @details
///		Union of all data structures across all tags
//-----------------------------------------------------------------------------
union TAGS {
    TAG tag;
    TAG_DATA data;
    TAG_OBJECT_BEGIN objectBegin;
    TAG_OBJECT_METADATA metadata;
    TAG_OBJECT_STREAM_BEGIN streamBegin;
    TAG_OBJECT_STREAM_DATA streamData;
    TAG_OBJECT_STREAM_ENCRYPTED streamEncrypted;
    TAG_OBJECT_STREAM_END streamEnd;
    TAG_OBJECT_END objectEnd;
    TAG_ENCRYPTION_KEY encryptionKey;
    TAG_ENCRYPTED encrypted;
    TAG_COMPRESSED compressed;
    TAG_HASH hash;
};

#pragma pack(pop)

//-----------------------------------------------------------------------------
/// @details
///		Render the long form of a tag enumeration
///	@param[in]	tagid
///		Tag id to parse
///	@returns
///		A constant literal view display name of the tag
//-----------------------------------------------------------------------------
_const TextView getTagName(TAG_ID tagId) noexcept {
    switch (tagId) {
        case TAG_OBJECT_BEGIN::ID:
            return "TAG_OBJECT_BEGIN";
        case TAG_OBJECT_METADATA::ID:
            return "TAG_OBJECT_METADATA";
        case TAG_OBJECT_STREAM_BEGIN::ID:
            return "TAG_OBJECT_STREAM_BEGIN";
        case TAG_OBJECT_STREAM_DATA::ID:
            return "TAG_OBJECT_STREAM_DATA";
        case TAG_OBJECT_STREAM_ENCRYPTED::ID:
            return "TAG_OBJECT_STREAM_ENCRYPTED";
        case TAG_OBJECT_STREAM_END::ID:
            return "TAG_OBJECT_STREAM_END";
        case TAG_OBJECT_END::ID:
            return "TAG_OBJECT_END";

        case TAG_ENCRYPTION_KEY::ID:
            return "TAG_KEY";
        case TAG_ENCRYPTED::ID:
            return "TAG_ENCRYPTED";
        case TAG_COMPRESSED::ID:
            return "TAG_COMPRESSED";
        case TAG_HASH::ID:
            return "TAG_HASH";
        default:
            return "Invalid tag";
    }
}

//-----------------------------------------------------------------------------
/// @details
///		Render the long form of a tag enumeration
///	@param[in]	tagid
///		Tag id to parse
///	@returns
///		A constant literal view display name of the tag
//-----------------------------------------------------------------------------
_const TextView
getTagStreamDataType(TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE type) noexcept {
    switch (type) {
        case TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_DATA:
            return "Stream data";
        case TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_EA_DATA:
            return "EA data";
        case TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_SECURITY_DATA:
            return "Security data";
        case TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_ALTERNATE_DATA:
            return "Alternate data";
        case TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_LINK:
            return "Link";
        case TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_OBJECT_ID:
            return "Object id";
        case TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_REPARSE_DATA:
            return "Reparse data";
        case TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_SPARSE_BLOCK:
            return "Sparse data";
        case TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_TXFS_DATA:
            return "Transaction data";
        case TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_GHOSTED_FILE_EXTENTS:
            return "Ghosted data";
        default:
            return "Invalid type";
    }
}
}  // namespace engine::store
