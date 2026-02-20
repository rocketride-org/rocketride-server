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

//-----------------------------------------------------------------------------
//
// Defines the stat interface for the generic S3/object storage endpoint
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::baseObjectStore {
//---------------------------------------------------------------------
/// @details
///		Determines existence of the entry
///	@param[in]	entry
///		The entry that should be stat-ed
///	@returns
///		ErrorOr<bool>
///         - where
///             Error if there are some errors
///             true  if file was deleted
///             false if entry exists is a file
//---------------------------------------------------------------------

ErrorOr<bool> IBaseInstance::stat(Entry& entry) noexcept {
    Error ccode;
    // Get the path from URL
    Text path;
    if (ccode = Url::toPath(entry.url(), path)) return ccode;

    LOGT("Checking existence of file:", entry.url().fileName());

    Text bucket, key;
    endpoint.extractBucketAndKeyFromPath(path, bucket, key);

    // Define a HeadObjectRequest
    const auto objectsReq =
        Aws::S3::Model::HeadObjectRequest().WithBucket(bucket).WithKey(key);

    // Get the metadata from the bucket
    auto objectsResp = m_streamClient->HeadObject(objectsReq);
    if (objectsResp.IsSuccess()) return false;
    return true;
}
}  // namespace engine::store::filter::baseObjectStore