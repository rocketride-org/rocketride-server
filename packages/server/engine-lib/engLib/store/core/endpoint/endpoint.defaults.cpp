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

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		This function will compute the target path based on the
///		the source path and the services base and path settings
///
///			sourcePath= "C:/Python27/doc/README.txt"
///			serviceConfig.base = "C:/Python27"
///			serviceConfig.path = "D:/dir"
///
///		this will be set to
///			D:/dir/doc/README.TXT
///
///		Note that the path MAY contain the drive component on Windows
///		which is illegal, so this needs to be changes to a $ by the
///		caller
///
/// @param[in]	sourceUrl
///		The local source url
///	@param[out]	targetPath
///		Receives the target url
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::mapPath(const Url &sourceUrl, Url &targetUrl) noexcept {
    Dword index;

    // Get the source path
    Path sourcePath;
    if (auto ccode = Url::toPath(sourceUrl, sourcePath)) return ccode;

    // Get the target protocol
    // @@HACK - this goes agains every design principle of the engine. This
    // eliminates the plug architecture and limits how we can
    TextView targetProtocol;
    if (config.logicalType == filter::null::Type ||
        config.logicalType == filter::filesys::filesys::Type ||
        config.logicalType == filter::filesys::smb::Type ||
        config.logicalType == filter::objstore::Type ||
        config.logicalType == filter::s3::Type ||
        config.logicalType == filter::azure::Type ||
        config.physicalType == filter::python::Type ||
        config.logicalType == filter::sharepoint::Type ||
        config.logicalType == filter::outlook::TypeEnterprise ||
        config.logicalType == filter::outlook::TypePersonal)
        targetProtocol = config.logicalType;
    else if (config.logicalType == engine::store::filter::zip::Type)
        // APPLAT-2912: Zip endpoint uses only the path of the target url to
        // build a zipnet-url later
        targetProtocol = sourceUrl.protocol();
    else
        // Return an informative error if the target protocol not supported
        return APERR(Ec::NotSupported, "Mapping source url", sourceUrl,
                     "for task", config.logicalType, "not supported");

    // Get the target path
    auto targetPath = config.storePath;

    // Strip off all of the source path that matches the
    // base path
    for (index = 0;
         index < sourcePath.count() && index < config.commonTargetPath.count();
         index++) {
        // Get the source and base components
        auto sourceComp = sourcePath[index];
        auto baseComp = config.commonTargetPath[index];

        // If these do not match, we found the place
        // to strip it
        if (sourceComp != baseComp) break;
    }

    if (config.flatten) {
        // Flattening logic: Add only the filename
        auto filename =
            (Text)sourcePath.back();  // Get the last path component (filename)
        targetPath /=
            filename;  // Append the modified filename to the target path
    } else {
        // Add all the remaining source components to the target
        for (; index < sourcePath.count(); index++) {
            // If this is the first component of the source - it map have a
            // colon on it - due to it being a windows drive and all, so
            // change it to a $
            if (!index) {
                auto sourceComp = ((Text)sourcePath[index]).replace(':', '$');
                targetPath /= sourceComp;
            } else {
                auto sourceComp = sourcePath[index];
                targetPath /= sourceComp;
            }
        }
    }

    // Convert back into a url
    return Url::toUrl(targetProtocol, targetPath, targetUrl);
}

//-----------------------------------------------------------------
/// @details
///		Make static, finalized configs
//-----------------------------------------------------------------
Error IServiceEndpoint::getConfigSubKey(Text &key) noexcept {
    key = "*";
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Perform a scan for objects Call the callback with each
///		object found.
///	@param[in]	callback
///		Pass a Entry with all the information filled
//-----------------------------------------------------------------
Error IServiceEndpoint::scanObjects(Path &path,
                                    const ScanAddObject &callback) noexcept {
    return APERRT(Ec::InvalidCommand, "The", config.protocol,
                  "service does not support source scanning (scanObjects)");
}

}  // namespace engine::store
