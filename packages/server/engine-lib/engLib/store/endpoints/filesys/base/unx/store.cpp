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
//	Defines the operations used for storing tagged formatted objects in native
//format.
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::filesys::base {
//-----------------------------------------------------------------------------
/// @details
///		Recover metadata using a current file
///	@returns
///		Error
//-----------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::setMetadata() noexcept {
    if (m_metadata.isMember("linux")) {
        const auto linuxData = m_metadata["linux"];

        if constexpr (LogLevel == log::Lvl::ServiceFilesys) {
            // Set normal file attributes
            if (::fchmod(m_targetFile.platHandle(), m_attributes))
                return APERRT(errno, "Cannot set st_mode on file");
            // Set owners
            if (::fchown(m_targetFile.platHandle(),
                         linuxData["ownerId"].asUInt(),
                         linuxData["groupId"].asUInt()))
                return APERRT(errno, "Cannot set ownerId and groupId on file");
        } else if constexpr (LogLevel == log::Lvl::ServiceSmb) {
            // Set normal file attributes
            if (auto ccode = file::smb::client().chmod(m_targetFile.path(),
                                                       m_attributes))
                return ccode;
        } else {
            return APERRT(Ec::NotSupported);
        }
    }
    // If the source object metadata has times
    if (m_metadata.isMember("modifyTime") &&
        m_metadata.isMember("accessTime")) {
        auto atimeSys = time::fromTimeT<time::SystemStamp>(
            m_metadata["accessTime"].asUInt64());
        auto mtimeSys = time::fromTimeT<time::SystemStamp>(
            m_metadata["modifyTime"].asUInt64());

        if constexpr (LogLevel == log::Lvl::ServiceFilesys) {
            // Convert the times, generic times are all posix stamps
            const timespec times[2] = {_tr<timespec>(atimeSys),
                                       _tr<timespec>(mtimeSys)};
            // Update file times
            if (::futimens(m_targetFile.platHandle(), times))
                return APERRT(
                    errno, "Cannot set access and modification times on file");
        } else if constexpr (LogLevel == log::Lvl::ServiceSmb) {
            // Convert the times, generic times are all posix stamps
            const timeval times[2] = {_tr<timeval>(atimeSys),
                                      _tr<timeval>(mtimeSys)};
            // Update file times
            if (auto ccode =
                    file::smb::client().utimes(m_targetFile.path(), times))
                return ccode;
        } else {
            return APERRT(Ec::NotSupported);
        }
    }

    return {};
}

//-----------------------------------------------------------------------------
/// @details
///		Create the path to a filename if it does not exist
///	@param[in]	url
///		the url of the path to create (including filename, which
///		will not be created)
/// @returns
///		Error
//-----------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::createParentPath(const Url &url) noexcept {
    // Get the path
    Text osPath;
    if (auto ccode = Url::osPath(url.parent(), osPath)) return ccode;

    // Create it
    return ap::file::mkdir(osPath);
}

//-----------------------------------------------------------------------------
/// @details
///		Create a file for recover
///	@param[in]	url
///		the url to recover
/// @returns
///		Error
//-----------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::createStandardFile(const Url &url) noexcept {
    Error ccode;

    Text osParentPath;
    if ((ccode = Url::osPath(url.parent(), osParentPath))) return ccode;

    // We are recovering file, prevent other processes from opening a file
    using DirPtr = std::unique_ptr<DIR, decltype(&::closedir)>;
    DirPtr dir(::opendir(osParentPath), &::closedir);
    if (!dir && errno == ENOENT) {
        // Directory doesn't exist - create it
        if (errno == ENOENT) {
            if ((ccode = createParentPath(url))) return ccode;
        } else {
            return APERRT(errno, "Failed to open parent directory:",
                          (TextView)url.parent());
        }
    }

    Text osPath;
    if ((ccode = Url::osPath(url, osPath))) return ccode;

    if (m_isLink) {
        if constexpr (LvlT == log::Lvl::ServiceFilesys) {
            int res = ::unlink(
                osPath);  // try to unlink before creating new link (succeeds
                          // only if link osPath already exists)
            res = ::symlink(
                m_linkTo,
                osPath);  // create new link named osPath pointing to m_linkTo
            if (res == -1) {
                return APERRT(errno, "Create symlink", osPath, m_linkTo);
            } else {
                return {};
            }
        }
    }

    if (auto ccode = m_targetFile.open(Path(osPath), file::Mode::WRITE))
        return ccode;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Proesses a new object stream header
///	@param[in]	pTag
///		The stream begin tag
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::processObjectStreamBegin(
    TAG_OBJECT_STREAM_BEGIN *pTag) noexcept {
    // Save the offset
    m_dataOffset = pTag->data.streamOffset;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Proesses the data within the stream
///	@param[in]	pTag
///		The stream data tag
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::processObjectStreamData(
    TAG_OBJECT_STREAM_DATA *pTag) noexcept {
    // Set the file pointer
    if (auto pos = m_targetFile.seek(m_dataOffset, SEEK_SET); pos.check())
        return pos.ccode();

    // Write the file directly
    auto tagData = InputData(pTag->data.data, pTag->size);
    if (auto ccode = m_targetFile.write(tagData)) return ccode;

    // Update for the next write
    m_dataOffset += pTag->size;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Processes the metadata saved with the object. A lot of things cannot
///		be done until we have this metadata which should be pretty much the
///		first thing in the tag stream.
///	@param[in]	pTag
///		The metadata tag
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::processMetadata(
    TAG_OBJECT_METADATA *pTag) noexcept {
    Error ccode;

    // And output
    m_metadata = json::parse(pTag->data.value);

    // `isObjectUpdateNeeded` may fail, or set completion code -> check both
    if (ccode = isObjectUpdateNeeded(m_targetObjectUrl)) return ccode;
    if (currentEntry->objectFailed()) return {};

    // Setup the flags for easy processing
    m_metadataFlags = m_metadata["flags"].asUInt();

    m_isLink = m_metadata["isLink"].asBool();
    if (m_isLink && m_metadata.isMember("linux")) {
        m_linkTo = m_metadata["linux"]["linkTo"].asString();
    }

    // Grab the file attributes
    if (m_metadata.isMember("linux"))
        m_attributes = m_metadata["linux"]["attributes"].asUInt();
    else
        m_attributes = 0;

    if ((ccode = createStandardFile(m_targetObjectUrl))) return ccode;

    // No error
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Prepare to write a file in native mode
///	@param[in]	entry
///		The object info from the input pipe
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::open(Entry &entry) noexcept {
    Error ccode;

    // Create the target path
    if ((ccode = endpoint->mapPath(entry.url(), m_targetObjectUrl)))
        return ccode;

    return Parent::open(entry);
}

//-------------------------------------------------------------------------
/// @details
///		Process and write a tag
///	@param[in]	pTag
///		The tag from input pipe
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::writeTag(const TAG *pTag) noexcept {
    Error ccode;

    // object may be failed, so skip any operation with it
    // one of possible reasons:
    //  - export from RocketRide format to filesystem/SMB,
    //    and object already exists on target, and should not be updated
    if (currentEntry->objectFailed()) return {};

    auto filePath = currentEntry->url().fullpath();

    if (filePath.containsInvalidCharacters()) {
        MONERR(warning, Ec::InvalidFilename,
               "Skipping file with invalid characters:", filePath);
        currentEntry->completionCode(
            APERR(Ec::Warning, "Skipping file with invalid characters"));
        return {};
    }

    // Switch it to generic format so we can read the
    // data values from it
    TAGS *pTagData = (TAGS *)pTag;

    // Based on the tag type
    switch (pTag->tagId) {
        case TAG_OBJECT_METADATA::ID: {
            // Process the metadata
            ccode = processMetadata(&pTagData->metadata);
            break;
        }

        case TAG_OBJECT_STREAM_BEGIN::ID: {
            // Begin a new stream within the object
            m_isPrimary =
                isPrimaryDataStream((TAG_OBJECT_STREAM_BEGIN *)(pTag));
            if (m_isPrimary)
                ccode = processObjectStreamBegin(&pTagData->streamBegin);
            break;
        }

        case TAG_OBJECT_STREAM_DATA::ID: {
            // Write stream data
            if (m_isPrimary)
                ccode = processObjectStreamData(&pTagData->streamData);
            break;
        }

        case TAG_OBJECT_STREAM_END::ID: {
            m_isPrimary = false;
            // no need to do anything
            break;
        }
        default:
            // Ignore any unknown tags
            break;
    }

    // Done processing this tag
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Finished writing a file. Close it out
///	@param[in]	completionCode
///		Code whether previous operation failed or not
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::close() noexcept {
    Text osPath;
    if (auto ccode = Url::osPath(m_targetObjectUrl, osPath)) return ccode;

    // If we didn't have any error, set the metadata
    // for symlinks all attributes are set automatically with syscall symlink())
    if (!currentEntry->objectFailed() && !m_isLink) {
        if (auto ccode = setMetadata()) currentEntry->completionCode(ccode);
    }

    // Close the file
    if (m_targetFile) {
        m_targetFile.close();
    }

    if (!currentEntry->objectFailed()) {
        // update current entry with actual size
        auto statOr = ap::file::stat(osPath, true);
        if (statOr.hasCcode())
            currentEntry->completionCode(statOr.ccode());
        else
            currentEntry->size(statOr->size);
    }

    m_metadataFlags = 0;
    m_attributes = 0;
    m_dataOffset = 0;
    m_isLink = false;
    m_linkTo = {};

    return Parent::close();
}
}  // namespace engine::store::filter::filesys::base
