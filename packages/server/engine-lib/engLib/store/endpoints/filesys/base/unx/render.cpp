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
//	Defines the object render for Linux files - this renders a native
//	object on the file system into a tagged format
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::filesys::base {
//-------------------------------------------------------------------------
/// @details
///		Store the metadata of a file to the channel
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::sendTagMetadata(ServicePipe &target,
                                              const Text &osPath,
                                              const ap::file::StatInfo &stat,
                                              Entry &object) noexcept {
    Error ccode;

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if ((ccode = getTagBuffer(&pTagBuffer))) return ccode;

    // Fill in the generic data
    json::Value linuxData;

    // @@TODO: Seems like changeTime cannot be set if restoring file
    if (!stat.changeTime) {
        auto ccode = APERR(errno, "changeTime wasn't filled");
        return object.completionCode(ccode);
    }

#ifdef ROCKETRIDE_PLAT_MAC
    linuxData["changeTime"] = static_cast<unsigned long>(
        time::toTimeT(_tr<time::SystemStamp>(*stat.changeTime)));
#else
    linuxData["changeTime"] =
        time::toTimeT(_tr<time::SystemStamp>(*stat.changeTime));
#endif
    linuxData["ownerId"] = (Dword)(stat.plat.st_uid);
    linuxData["groupId"] = (Dword)(stat.plat.st_gid);
    linuxData["attributes"] = (Dword)stat.plat.st_mode;

    // if this is link store its pointer to metadata as well
    if (stat.isLink) {
        Text buf;
        buf.resize(stat.size);
        int res = ::readlink(osPath, buf.data(), buf.size());
        if (res == -1) {
            auto ccode = APERR(errno, "Read symlink", osPath, buf.size());
            return object.completionCode(ccode);
        } else {
            linuxData["linkTo"] = buf;
        }
    }

    json::Value data;
    // Unset Windows flag
    data["flags"] = TAG_OBJECT_METADATA::FLAGS::NONE, data["path"] = osPath;
    data["isContainer"] = stat.isDir;
    data["isLink"] = stat.isLink;
    data["size"] = stat.size;
#ifdef ROCKETRIDE_PLAT_MAC
    data["accessTime"] = static_cast<unsigned long>(
        time::toTimeT(_tr<time::SystemStamp>(stat.accessTime)));
    data["modifyTime"] = static_cast<unsigned long>(
        time::toTimeT(_tr<time::SystemStamp>(stat.modifyTime)));
#else
    data["accessTime"] = time::toTimeT(_tr<time::SystemStamp>(stat.accessTime));
    data["modifyTime"] = time::toTimeT(_tr<time::SystemStamp>(stat.modifyTime));
#endif

    data["linux"] = linuxData;

    // Stringify the json object
    auto metadataString = data.stringify(true);

    // Build the tag
    const auto pMetadata =
        TAG_OBJECT_METADATA::build(pTagBuffer, &metadataString)
            ->setAttributes(TAG_ATTRIBUTES::INSTANCE_DATA);

    // Write it out
    return pDown->sendTag(target, pMetadata);
}

//-------------------------------------------------------------------------
/// @details
///		Starts rendering the file data
///	@param[in]	fileHandle
///		The file descriptor to render from
///	@param[in]	target
///		The Pipe to render the object to
///	@param[in]	pTagBuffer
///		The tag buffer used for a new tag
///	@param[in]	type
///		The object stream type
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::sendTagBeginStream(FileStream &fileStream,
                                                 ServicePipe &target,
                                                 TAG *pTagBuffer,
                                                 Entry &object) noexcept {
    // Setup
    auto type = TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_DATA;
    size_t prevPosition = 0;
    size_t offset = 0;
    size_t endOfFile = 0;
    size_t streamOffset = 0;

    if (auto pos = fileStream.seek(0, SEEK_CUR); pos.check())
        return object.completionCode(pos.ccode());
    else
        prevPosition = _mv(*pos);

    if (auto pos = fileStream.seek(0, SEEK_END); pos.check())
        return object.completionCode(pos.ccode());
    else
        endOfFile = _mv(*pos);

    // Check for sparseness in nonempty files
    if (endOfFile > 0) {
        if (auto pos = fileStream.seek(0, SEEK_HOLE); pos.check())
            return object.completionCode(pos.ccode());
        else
            offset = _mv(*pos);

        if (offset != endOfFile) {
            type = TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_SPARSE_BLOCK;
            streamOffset = offset;
        }
    }

    // Restore the cursor
    if (auto pos = fileStream.seek(prevPosition, SEEK_SET); pos.check())
        return object.completionCode(pos.ccode());
    else
        offset = _mv(*pos);

    // Setup the default stream begin tag
    auto pStreamBeginTag = TAG_OBJECT_STREAM_BEGIN::build(pTagBuffer, type);

    pStreamBeginTag->setStreamOffset(streamOffset);

    // Write it
    if (auto ccode = pDown->sendTag(target, pStreamBeginTag)) return ccode;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Ends rendering the file data
///	@param[in]	target
///		The Pipe to render the object to
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::sendTagEndStream(ServicePipe &target) noexcept {
    // Create the tag
    const auto streamEndTag = TAG_OBJECT_STREAM_END();

    // Write the stream end tag
    return pDown->sendTag(target, &streamEndTag);
};

//-------------------------------------------------------------------------
/// @details
///		Store a standard file
///	@param[in]	channel
///		The channel to store it to
///	@param[in]	osPath
///		The local path to the object
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::renderStandardFile(ServicePipe &target,
                                                 const Text &osPath,
                                                 Entry &object) noexcept {
    Error ccode;

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if ((ccode = getTagBuffer(&pTagBuffer))) return ccode;

    Qword offset = 0;
    Dword sizeToRead;
    Dword sizeRead;

    auto statOr = ap::file::stat(osPath);
    if (!statOr) return object.completionCode(statOr.ccode());

    auto stat = _mv(*statOr);

    // if it's a directory we are done
    if (stat.isDir) return {};

    // omit corner case when scanning system files on linux (like /sys/devices
    // etc) actually this case perfectly handled by global excludes but just in
    // case it wasn`t applied for some reason leave this check here to not to
    // hang
    if (!stat.isLink && stat.size != 0 && stat.sizeOnDisk == 0) {
        return {};
    }

    // Now read the underlying data
    // Stop when no more bytes to read
    auto size = stat.size;
    FileStream fileStream;

    // Store file metadata
    if ((ccode = sendTagMetadata(target, osPath, stat, object)) ||
        object.objectFailed())
        goto done;

    // Dealing with links if fully about passing the metadata
    // and it is all done in sendTagMetadata() few lines higher
    if (stat.isLink) {
        return {};
    }

    if (ccode = fileStream.open(Path(osPath), file::Mode::READ))
        return object.completionCode(ccode);

    if ((ccode = sendTagBeginStream(fileStream, target, pTagBuffer, object)) ||
        object.objectFailed())
        goto done;

    // While we have bytes to retrieve
    while (size > 0) {
        // Get the amount of data we are going to read in this pass
        if (size > MAX_IOSIZE)
            sizeToRead = MAX_IOSIZE;
        else
            sizeToRead = (Dword)size;

        // Build the tag
        const auto pDataTag = TAG_OBJECT_STREAM_DATA::build(pTagBuffer);

        auto dataBuffer = OutputData(pDataTag->data.data, sizeToRead);
        if (auto sizeReadOr = fileStream.read(dataBuffer); sizeReadOr.check()) {
            ccode = object.completionCode(sizeReadOr.ccode());
            break;
        } else
            sizeRead = _mv(*sizeReadOr);

        // Set the size of the data to write
        pDataTag->setDataSize(sizeRead);

        // Write the data stream
        if ((ccode = pDown->sendTag(target, pDataTag)) || object.objectFailed())
            break;

        // Move on
        size -= sizeRead;
    }

    // End the stream
    ccode = sendTagEndStream(target);

done:
    // Now, if it was the object that failed, then return the no error since
    // it was not the target, and we can continue
    if (ccode && object.objectFailed())
        return {};
    else
        return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Store an object
///	@param[in]	target
///		the output channel
///	@param[in]	object
///		object information
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::renderObject(ServicePipe &target,
                                           Entry &object) noexcept {
    Error ccode;

    // Get the os path
    Text osPath;
    if (ccode = Url::osPath(object.url(), osPath)) return ccode;

    // Output the begin tag
    if ((ccode = sendTagBeginObject(target)) || object.objectFailed())
        goto done;

    if ((ccode = renderStandardFile(target, osPath, object)) ||
        object.objectFailed())
        goto done;

    // Output the end tag
    ccode = sendTagEndObject(target, ccode);

done:
    // Now, if it was the object that failed, then return the no
    // error since it was not the target, and we can continue
    if (ccode && object.objectFailed())
        return {};
    else
        return ccode;
};
}  // namespace engine::store::filter::filesys::base
