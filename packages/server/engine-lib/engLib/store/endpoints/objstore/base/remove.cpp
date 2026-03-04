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

//-----------------------------------------------------------------------------
//
// Defines the remove interface for the generic S3/object storage endpoint
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::baseObjectStore {
//-----------------------------------------------------------------
/// @details
///		Removes the entry
///	@param[in] entry
///		The entry to remove
///	@returns
///		Error
//-----------------------------------------------------------------
Error IBaseInstance::removeObject(Entry &entry) noexcept {
    Error ccode;

    // Get the path
    Text path;
    if (ccode = Url::toPath(entry.url(), path)) return ccode;

    LOGT("Add object to delete: {}", path);

    Text bucket, key;
    endpoint.extractBucketAndKeyFromPath(path, bucket, key);

    // Define the request to delete the segment
    auto delRequest =
        Aws::S3::Model::DeleteObjectRequest().WithBucket(bucket).WithKey(key);

    LOGT("Deleting {} object...", path);

    // Delete the segment
    auto delResponse = m_streamClient->DeleteObject(delRequest);
    if (!delResponse.IsSuccess())
        return errorFromS3Error(m_streamClient, _location,
                                delResponse.GetError(), bucket);

    LOGT("{} object removed", path);

    return {};
}
}  // namespace engine::store::filter::baseObjectStore
