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
//	Defines the remove interface for the azure storage endpoint
//
//-----------------------------------------------------------------------------

namespace engine::store::filter::azure {
//-------------------------------------------------------------------------
/// @details
///     Remove the entry object
/// @param[in]  object
///     The name to remove
/// @returns
///     Error
//-------------------------------------------------------------------------
Error IFilterInstance::removeObject(Entry &object) noexcept {
    Error ccode;

    // get the filename
    std::shared_ptr<Azure::Storage::Blobs::BlobContainerClient>
        blobContainerClient;
    auto errorOr = processPath(object, blobContainerClient);
    if (errorOr.hasCcode()) return errorOr.ccode();

    Text pathName = errorOr.value().gen();

    LOGT("Removing object: {}", pathName);
    auto blob =
        blobContainerClient->GetBlobClient(Text(object.url().path().subpth(2)));

    auto deleted = blob.DeleteIfExists();
    if (!deleted.Value.Deleted) {
        LOGT("Azure object '{}' {}", pathName,
             "couldn't be deleted because doesn't exist");
    }
    return {};
}
}  // namespace engine::store::filter::azure
