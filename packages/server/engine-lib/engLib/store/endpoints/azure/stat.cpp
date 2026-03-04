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
//	Defines the stat function.
//  These are for object existence//
//-----------------------------------------------------------------------------

namespace engine::store::filter::azure {
//---------------------------------------------------------------------
/// @details
///		Determines existence of the entry
///	@param[in]	object
///		The entry object that should be stat-ed
///	@returns
///		ErrorOr<bool>
///         - where
///             Error if there are some errors
///             true  if file was deleted (couldn't be stat: entry doesn't
///             exist, is a directory not a file) false if entry exists is a
///             file
//---------------------------------------------------------------------
ErrorOr<bool> IFilterInstance::stat(Entry &object) noexcept {
    LOGT("Checking existence of Azure object '{}'", object.fileName());
    std::shared_ptr<Azure::Storage::Blobs::BlobContainerClient>
        blobContainerClient;
    auto errorOr = processPath(object, blobContainerClient);
    if (errorOr.hasCcode()) return errorOr.ccode();
    Text pathName = errorOr.value().gen();

    LOGT("Checking for changes Azure object '{}'", pathName);
    if (auto ccode = callAndCatch(
            _location, "Checking for changes Azure object", [&]() -> Error {
                auto blob = blobContainerClient->GetBlobClient(pathName);
                Azure::Response<Azure::Storage::Blobs::Models::BlobProperties>
                    blobProperties = blob.GetProperties();
                auto blobValues = blobProperties.Value;
                // Skip if Blob is not in Hot Storage
                auto accessTier = blobValues.AccessTier.ValueOr(
                    Azure::Storage::Blobs::Models::AccessTier::Cold);
                if (accessTier !=
                    Azure::Storage::Blobs::Models::AccessTier::Hot) {
                    return MONERR(
                        warning, Ec::Warning,
                        "Skipping: Blob has been moved out of the hot storage",
                        pathName);
                }
                return {};
            })) {
        // Blob doesn't exists
        MONERR(warning, Ec::Warning, "Azure blob check for existance: blob '",
               pathName, "' doesn't exist");
        return true;
    }
    return false;
}

}  // namespace engine::store::filter::azure
