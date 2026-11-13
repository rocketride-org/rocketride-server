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
///		Defines the object begin tag
//-------------------------------------------------------------------------
struct TAG_OBJECT_BEGIN : TAG {
public:
    //-----------------------------------------------------------------
    /// @details
    ///		Define the constant ID
    //-----------------------------------------------------------------
    _const auto ID = TAG_ID::OBEG;

    //-----------------------------------------------------------------
    /// @details
    ///		Build the tag
    //-----------------------------------------------------------------
    static auto build(void *pBuffer) {
        // Given a generic memory block, cast over to the appropriate type
        auto *pTag = (TAG_OBJECT_BEGIN *)pBuffer;

        // Set it up
        TAG::build(pTag, ID, 0);

        // And return it so we can chain
        return pTag;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Inplace tag constructor
    //-----------------------------------------------------------------
    TAG_OBJECT_BEGIN() { build(this); }
};
}  // namespace engine::store
