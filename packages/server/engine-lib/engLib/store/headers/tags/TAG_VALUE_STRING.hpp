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
///		Defines a tag which takes a variable string value
//-------------------------------------------------------------------------
struct TAG_VALUE_STRING : TAG {
public:
    //-----------------------------------------------------------------
    /// @details
    ///		Define the data for the tag
    //-----------------------------------------------------------------
    struct DATA {
        //-------------------------------------------------------------
        /// @details
        ///		The string with JSON encoding
        //-------------------------------------------------------------
        TextChr value[1] = {0};
    };

    //-----------------------------------------------------------------
    /// @details
    ///		Declare the data for the tag
    //-----------------------------------------------------------------
    DATA data;

    //-----------------------------------------------------------------
    /// @details
    ///		Set the string - may not be null terminated if the
    ///		string length is != 0
    //-----------------------------------------------------------------
    auto setString(Text *pValue) {
        const auto pString = pValue->c_str();
        Txtcpy(data.value, MAX_IOSIZE, pString);

        const auto stringSize = (Dword)pValue->size();
        setPayloadSize(stringSize + 1);
        return this;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Build the tag
    //-----------------------------------------------------------------
    static auto build(void *pBuffer, TAG_ID tagId, Text *pValue = nullptr) {
        // Given a generic memory block, cast over to the appropriate type
        auto *pTag = (TAG_VALUE_STRING *)pBuffer;

        // Set it up
        TAG::build(pTag, tagId, sizeof(DATA));

        if (pValue) pTag->setString(pValue);

        // And return it so we can chain
        return pTag;
    }

private:
    //-----------------------------------------------------------------
    /// @details
    ///		The constructor is private. We cannot build this
    ///		with a declaration since the length is dynamic
    //-----------------------------------------------------------------
    TAG_VALUE_STRING() {};
};
}  // namespace engine::store
