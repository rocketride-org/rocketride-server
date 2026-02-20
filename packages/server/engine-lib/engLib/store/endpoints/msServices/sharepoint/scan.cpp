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

namespace engine::store::filter::sharepoint {
//-----------------------------------------------------------------
/// @details
///        Perform a scan for objects Call the callback with each
///        object found.
///    @param[in]    path
///        Path to scanned object, includes account name which is cut off from
///        processing, and later added if needed
///    @param[in]    callback
///        Pass a Entry with all the information filled
//-----------------------------------------------------------------
Error IFilterEndpoint::scanObjects(Path &path,
                                   const ScanAddObject &callback) noexcept {
    // Create getSyncToken callback
    const msNode::GetSyncTokenCallBack getSyncTokenFn =
        [this](TextView key) -> ErrorOr<Text> { return getSyncToken(key); };
    // Create setSyncToken callback
    const msNode::SetSyncTokenCallBack setSyncTokenFn =
        [this](TextView key, TextView value) -> Error {
        return setSyncToken(key, value);
    };

    if (auto ccode = m_msSharepointNode->getItems(
            path, callback, setSyncTokenFn, getSyncTokenFn)) {
        LOGT("Failed to scan path '{}': {}", path, ccode);
        return {};
    }

    return {};
}
}  // namespace engine::store::filter::sharepoint