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
//    Defines the object render for Objstore files - this renders a native
//    object on the S3 compatible system into a tagged format
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::baseObjectStore {
//-------------------------------------------------------------------------
/// @details
///    Checks if the object has changed. It does this by examining the
///    dates/times and anything else to determine if the object has
///    changed. If it has, this method should call the entry.markChanged<>
///    function. Also, if it has changed, be sure to update all the
///    changed fields in the entry
/// @param[inout] object
///    The entry to check/update
/// @returns
///     Error
//-------------------------------------------------------------------------
Error IBaseInstance::checkChanged(Entry &object) noexcept {
    Error ccode;

    // Defaut to no change
    object.changed(false);

    // Get the path
    Text path;
    if (ccode = Url::toPath(object.url(), path)) return ccode;

    Text bucket, key;
    endpoint.extractBucketAndKeyFromPath(path, bucket, key);

    // Define a request to read the object header metadata
    const auto objectReq =
        Aws::S3::Model::HeadObjectRequest().WithBucket(bucket).WithKey(key);

    // get the object header from the bucket
    auto objectResp = m_streamClient->HeadObject(objectReq);
    if (!objectResp.IsSuccess())
        return APERR(Ec::Error,
                     objectResp.GetError().GetExceptionName().c_str(),
                     objectResp.GetError().GetMessage().c_str());

    Qword size = objectResp.GetResultWithOwnership().GetContentLength();
    if (object.size() != size) {
        object.markChanged(LogLevel, "Size is different");
        object.size(size);
    }

    auto modifyTime = time::toTimeT(objectResp.GetResultWithOwnership()
                                        .GetLastModified()
                                        .UnderlyingTimestamp());
    if (object.modifyTime() != modifyTime) {
        object.markChanged(LogLevel, "Modification time is different");
        object.modifyTime(modifyTime);
    }

    return {};
}
}  // namespace engine::store::filter::baseObjectStore