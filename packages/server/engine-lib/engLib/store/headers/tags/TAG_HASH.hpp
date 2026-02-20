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
///		TAG representing hash
//-------------------------------------------------------------------------
struct TAG_HASH : TAG {
public:
    //-----------------------------------------------------------------
    /// @details
    ///		Define the constant ID
    //-----------------------------------------------------------------
    _const auto ID = TAG_ID::HASH;

    //-----------------------------------------------------------------
    /// @details
    ///		Define the data for the tag
    //-----------------------------------------------------------------
    struct DATA {
        //-------------------------------------------------------------
        /// @details
        ///		The hash data
        //-------------------------------------------------------------
        Byte data[1] = {0};
    };

    //-----------------------------------------------------------------
    /// @details
    ///		Declare the data for the tag
    //-----------------------------------------------------------------
    DATA data;

    //-----------------------------------------------------------------
    /// @details
    ///		Set the size of the hash data
    //-----------------------------------------------------------------
    auto setHashSize(Dword hashDataSize) {
        setPayloadSize(offsetof(DATA, data) + hashDataSize);
        return this;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Build the tag
    //-----------------------------------------------------------------
    static auto build(void *pBuffer) {
        // Given a generic memory block, cast over to the appropriate type
        auto *pTag = (TAG_HASH *)pBuffer;

        // Set it up
        TAG::build(pTag, ID, offsetof(DATA, data));

        // And return it so we can chain
        return pTag;
    }

private:
    //-----------------------------------------------------------------
    /// @details
    ///		The constructor is deleted. We cannot build this
    ///		with a declaration since this is dynamic
    //-----------------------------------------------------------------
    TAG_HASH() = delete;
};
}  // namespace engine::store
