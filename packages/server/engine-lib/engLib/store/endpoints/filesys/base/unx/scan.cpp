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
//	Defines the segmented read/write functions. These are for getting
//  and putting data into the IO buffer on segmented files in the rocketride
//  format.
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::filesys::base {
//---------------------------------------------------------------------
/// @details
///		Processes an entry
///	@param[in]	objectPath
///		The object path
///	@param[in]	stat
///		The object stat information
/// @param[out] object
///     Entry object to fill with information
///	@param[in]	addObject
///		The function to add the object
///	@returns
///		Error
//---------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysEndpoint<LvlT>::processEntry(
    const Path &objectPath, const ap::file::StatInfo &stat, Entry &object,
    const ScanAddObject &addObject) noexcept {
    if (!stat.changeTime) {
        auto ccode = APERR(errno, "changeTime wasn't filled");
        return object.completionCode(ccode);
    }

    object.size(stat.size);
    object.attrib(stat.plat.st_mode);
#ifdef ROCKETRIDE_PLAT_LIN
    object.createTime(time::toTimeT(_tr<time::SystemStamp>(stat.createTime)));
    object.changeTime(time::toTimeT(_tr<time::SystemStamp>(*stat.changeTime)));
    object.modifyTime(time::toTimeT(_tr<time::SystemStamp>(stat.modifyTime)));
    object.accessTime(time::toTimeT(_tr<time::SystemStamp>(stat.accessTime)));
#else
    object.createTime(static_cast<unsigned long>(
        time::toTimeT(_tr<time::SystemStamp>(stat.createTime))));
    object.changeTime(static_cast<unsigned long>(
        time::toTimeT(_tr<time::SystemStamp>(*stat.changeTime))));
    object.modifyTime(static_cast<unsigned long>(
        time::toTimeT(_tr<time::SystemStamp>(stat.modifyTime))));
    object.accessTime(static_cast<unsigned long>(
        time::toTimeT(_tr<time::SystemStamp>(stat.accessTime))));
#endif
    object.name(objectPath.fileName());
    object.storeSize(0);

    // If it is the current indicator, skip it
    if (object.name() == "." || object.name() == "..") return {};

    // Tell the scanner wether we need to recurse "into" this
    if (stat.isDir) {
        // By default, it is a container
        object.isContainer(true);

        if (stat.isLink) {
            // Skip it
            return {};
        }

        // Directories do not have a storage size
        object.storeSize(0);
    } else {
        // By default, it is a container
        object.isContainer(false);

        // Set the stor size
        object.storeSize(stat.sizeOnDisk);
    }

    // Add the object
    return addObject(object);
};

//---------------------------------------------------------------------
/// @details
///		Given a path to scan, this function will enumerate the children and
///		call the add object function. We handle containers (directories)
///		the same as objects, just returning them and let the scanner
///		figure out what to do. It is up to this function to ensure that the
///		object should actually be included with the selection lists
///	@param[in]	path
///		Path to scan
///	@param[in] 	addObject
///		Ptr to the function to call for each object we found
///	@returns
///		Error
//---------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysEndpoint<LvlT>::scanObjects(
    Path &path, const ScanAddObject &addObject) noexcept {
    Entry object;
    uint64_t count = 0;
    Error ccode;

    // Create a url
    Url url;
    if (ccode = Url::toUrl(Type, path, url)) return ccode;

    // Get the os path
    Text osPath;
    if (ccode = Url::osPath(url, osPath)) return ccode;

    // Prepare the search path
    if (!osPath.endsWith("/")) osPath += "/";
    osPath += "*";

    auto start = time::now();
    _using(FileScanner dirScanner(osPath)) {
        if ((ccode = dirScanner.open())) {
            LOGT("Failed to open path '{}': {}", osPath, ccode);
            return {};  // do not return an error on scan
        }

        while (auto entry = dirScanner.next()) {
            // One more entry processed
            count++;
            const auto entryPath = dirScanner.pathOf(entry->first);
            if ((ccode = processEntry(entryPath, entry->second, object,
                                      addObject))) {
                MONERR(error, ccode, "Scanning on", entryPath, "failed");
                object.completionCode(ccode);
            }
        }
    }

    LOGT("Scan elapsed {}, completed {} objects", time::now() - start, path,
         count);

    // And return any error
    return ccode;
}
}  // namespace engine::store::filter::filesys::base
