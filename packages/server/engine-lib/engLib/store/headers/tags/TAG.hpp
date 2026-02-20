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

#pragma once

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Define the basic TAG. This is the first area of every tagged
///     data item
//-------------------------------------------------------------------------
struct TAG {
public:
    //-----------------------------------------------------------------
    /// @details
    ///		Define the signature indicating this is a valid tag
    //-----------------------------------------------------------------
    Dword signature = TAG_SIG;

    //-----------------------------------------------------------------
    /// @details
    ///		Define the actual tag
    //-----------------------------------------------------------------
    TAG_ID tagId = TAG_ID::INVALID;

    //-----------------------------------------------------------------
    /// @details
    ///		Attributes for the tag
    //-----------------------------------------------------------------
    Dword attributes = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		The size of data following this header - does not include
    ///		the header itself
    //-----------------------------------------------------------------
    Dword size = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		Set the size of the payload
    //-----------------------------------------------------------------
    auto setPayloadSize(Dword payloadSize) {
        size = payloadSize;
        return this;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Set the attributes
    //-----------------------------------------------------------------
    auto setAttributes(Dword tagAttributes) {
        attributes = tagAttributes;
        return this;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Build the tag
    //-----------------------------------------------------------------
    static auto build(void *pBuffer, TAG_ID tagId, Dword dataSize = 0) {
        // Given a generic memory block, cast over to the
        // appropriate type
        auto *pTag = (TAG *)pBuffer;

        // Set it up
        pTag->signature = TAG_SIG;
        pTag->tagId = tagId;
        pTag->attributes = 0;
        pTag->size = dataSize;

        // And return it so we can chain
        return pTag;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Inplace tag constructor
    //-----------------------------------------------------------------
    TAG(TAG_ID tagId, Dword dataSize = 0) { build(this, tagId, dataSize); }

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		Default constructor for use with build tag
    //-----------------------------------------------------------------
    TAG() {}
};
}  // namespace engine::store