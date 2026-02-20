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

namespace engine::store::filter::azure {
//-------------------------------------------------------------------------
/// @details
///		Checks if the object has changed. It does this by examining the
///		dates/times and anything else to determine if the object has
///		changed. If it has, this method should call the entry.markChanged<>
///		function. Also, if it has changed, be sure to update all the
///		changed fields in the entry
///	@param[inout] object
///		The entry to check/update
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::checkChanged(Entry &object) noexcept {
    LOGT("Checking for changes Azure object '{}'", object.fileName());
    std::shared_ptr<Azure::Storage::Blobs::BlobContainerClient>
        blobContainerClient;
    auto errorOr = processPath(object, blobContainerClient);
    if (errorOr.hasCcode()) return errorOr.ccode();

    Text pathName = errorOr.value().gen();

    Error ccode =
        callAndCatch(_location, "Checking for changes", [&]() -> Error {
            auto blob = blobContainerClient->GetBlobClient(
                Text(object.url().path().subpth(2)));
            Azure::Response<Azure::Storage::Blobs::Models::BlobProperties>
                blobProperties = blob.GetProperties();
            auto blobValues = blobProperties.Value;
            // Skip if Blob is not in Hot Storage
            auto accessTier = blobValues.AccessTier.ValueOr(
                Azure::Storage::Blobs::Models::AccessTier::Cold);
            if (accessTier != Azure::Storage::Blobs::Models::AccessTier::Hot) {
                return MONERR(
                    warning, Ec::Warning,
                    "Skipping: Blob has been moved out of the hot storage",
                    pathName);
            }
            object.changed(false);

            auto blobSize = blobValues.BlobSize;
            if (object.size() != (uint64_t)blobSize) {
                object.markChanged(LogLevel, "Size is different");
                object.size(blobSize);
            }

            time_t modifyTime =
                convertFromAzureDateTime(blobValues.LastModified);
            if (object.modifyTime() != modifyTime) {
                object.markChanged(LogLevel, "Modification time different");
                object.modifyTime(modifyTime);
            }

            time_t createTime = convertFromAzureDateTime(blobValues.CreatedOn);
            if (object.createTime() != createTime) {
                object.markChanged(LogLevel, "create time different");
                object.createTime(createTime);
            }

            return {};
        });

    if (ccode)
        return APERR(Ec::Unexpected, _location,
                     "Azure blob check for existance: blob '", pathName,
                     "' doesn't exist");
    return {};
}

}  // namespace engine::store::filter::azure
