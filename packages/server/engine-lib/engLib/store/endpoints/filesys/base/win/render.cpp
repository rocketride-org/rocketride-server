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
//	Defines the object render for Windows files - this renders a native
//	object on the file system into a tagged format
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::filesys::base {
//-------------------------------------------------------------------------
// <Hard Link, Junctions, and Symbolic links>
//
// "There are three types of links supported in Windows system: hard links,
// junctions, and symbolic links."
// Reference:
//		https://msdn.microsoft.com/en-us/library/windows/desktop/aa365006(v=vs.85).aspx
//
// To find out what is what, use FindFirstFile(), and check returned
// WIN32_FIND_DATAW data.
//
// We need special handling only for junction or symbolic link. If it is a
// junction or symbolic link, copy/recover that link, not target data.
// This way anything else will be actual target data including windows deduped
// files.
//-------------------------------------------------------------------------

//-------------------------------------------------------------------------
/// @details
///		Begins the filter operation
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::beginFilterInstance() noexcept {
    // Get the parameters
    if (auto ccode = endpoint->config.parameters.lookupAssign<bool>(
            "enableSecurity", opCommon.m_processSecurity))
        return ccode;

    // Call the parent
    return Parent::beginFilterInstance();
}

//-------------------------------------------------------------------------
/// @details
///		Store the metadata of a file to the channel
///	@param[in]	channel
///		The channel to store it to
///	@param[in]	url
///		The url to the object
///	@param[out]	findInfo
///		Receives the directory find information
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::sendTagMetadata(
    ServicePipe &target, const TAG_OBJECT_METADATA::FLAGS metadataFlags,
    const WIN32_FIND_DATAW &findInfo, Entry &object) noexcept {
    Error ccode;

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if (ccode = getTagBuffer(&pTagBuffer)) return ccode;

    // Fill in the generic data
    Qword size = ((Qword)findInfo.nFileSizeHigh) << 32 | findInfo.nFileSizeLow;

    json::Value windows;
    windows["createTime"] = _tr<Qword>(findInfo.ftCreationTime);
    windows["modifyTime"] = _tr<Qword>(findInfo.ftLastWriteTime);
    windows["accessTime"] = _tr<Qword>(findInfo.ftLastAccessTime);
    windows["attributes"] = (Dword)findInfo.dwFileAttributes;

    json::Value data;
    data["flags"] = metadataFlags;
    data["url"] = (TextView)object.url();
    data["isContainer"] =
        findInfo.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY ? true : false;
    data["size"] = size;
    data["createTime"] =
        time::toTimeT(_tr<time::SystemStamp>(findInfo.ftCreationTime));
    data["modifyTime"] =
        time::toTimeT(_tr<time::SystemStamp>(findInfo.ftLastWriteTime));
    data["accessTime"] =
        time::toTimeT(_tr<time::SystemStamp>(findInfo.ftLastAccessTime));
    data["windows"] = windows;

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
///		Store a standard file
///	@param[in]	target
///		The target endpoint to which to send data
///	@param[in]	url
///		The url of the object
///	@param[in]	osPath
///		The fully qualified os path (with \\.\...)
///	@param[in]	findInfo
///		The info we know about the file thus far
///	@param[in]	object
///		The filled in object from the job runner
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::renderStandardFile(
    ServicePipe &target, const Text &osPath, const WIN32_FIND_DATAW &findInfo,
    Entry &object) noexcept {
    HANDLE hFile = INVALID_HANDLE_VALUE;
    void *pContext = nullptr;
    Error ccode;

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if (ccode = getTagBuffer(&pTagBuffer)) return ccode;

    //
    // This internal read file function will use the BackupRead function
    // to read from the file and place data in the given buffer
    //
    const auto readFile =
        localfcn(void *pBuffer, Dword size, Dword &sizeRead)->Error {
        // Read it
        DWORD bytesRead = 0;
        bool bStatus = BackupRead(hFile, (BYTE *)pBuffer, size, &bytesRead,
                                  false, opCommon.m_processSecurity, &pContext);

        // If we failed...
        if (!bStatus)
            return object.completionCode(
                APERR(GetLastError(), "Cannot read from stream"));

        // If this is the end of stream signal...
        if (!bytesRead) {
            sizeRead = 0;
            return {};
        }

        // If we got what we wanted, then done
        if (size != bytesRead)
            // Generate the message
            return object.completionCode(APERR(
                Ec::End, "Sync error, size expected was {}, but only got {}",
                size, bytesRead));

        // All good
        sizeRead = bytesRead;
        return {};
    };

    //
    // Open the file
    //
    const auto openFile = localfcn()->Error {
        DWORD dwAccessMode;
        DWORD dwFlagsAndAttributes;

        // Setup the access mode, flags and attributes for the store operation
        dwAccessMode = FILE_GENERIC_READ | READ_CONTROL;

        // This flag was passed over in FPI but is apparently not needed here
        // since we are using backup semantics and we are not read/writing
        // the SACL directly
        // if (!Path::isShare(path))
        // {
        // 	dwAccessMode |= ACCESS_SYSTEM_SECURITY;
        // }

        dwFlagsAndAttributes = FILE_FLAG_BACKUP_SEMANTICS |
                               FILE_FLAG_OPEN_NO_RECALL |
                               FILE_FLAG_SEQUENTIAL_SCAN;

        // If this is a reparse point
        if (findInfo.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
            // If it is a junction or symbolic link, backup link not the target
            // data. For more info, see note "<Hard Link, Junctions, and
            // Symbolic links>" at the beginning of this file.
            if (findInfo.dwReserved0 == IO_REPARSE_TAG_APPEXECLINK ||
                findInfo.dwReserved0 == IO_REPARSE_TAG_WCI ||
                findInfo.dwReserved0 == IO_REPARSE_TAG_MOUNT_POINT ||
                findInfo.dwReserved0 == IO_REPARSE_TAG_SYMLINK) {
                dwFlagsAndAttributes |= FILE_FLAG_OPEN_REPARSE_POINT;
            }
        }

        // Open the file
        hFile = CreateFileW(osPath, dwAccessMode, FILE_SHARE_READ, nullptr,
                            OPEN_EXISTING, dwFlagsAndAttributes, nullptr);

        // If we could not open the file
        if (hFile == INVALID_HANDLE_VALUE)
            // Get the last error code
            return object.completionCode(
                APERR(GetLastError(), "Could not open"));
        return {};
    };

    //
    // This function will read the stream header from BackupRead, setup the
    // the TAG_OBJECT_STREAM_BEGIN, write it and return the amount of data
    // that needs to be read from the stream
    //
    const auto sendTagBeginStream =
        localfcn(TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE & type, Qword & dataSize,
                 bool &bComplete)
            ->Error {
        // Temporarily use the tag buffer - it is big and
        // can hold the entire stream name while we work on it
        auto pStreamHeader = (WIN32_STREAM_ID *)pTagBuffer;
        Dword size;
        Dword sizeRead;

        // Setup
        type = TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_DATA;
        dataSize = 0;
        bComplete = false;

        // Get the size of the stream header - not including the name
        size = offsetof(WIN32_STREAM_ID, cStreamName);

        // Read the next WIN32_STREAM_ID header
        if (ccode = readFile(pStreamHeader, size, sizeRead))
            return object.completionCode(ccode);

        // sizeRead set to 0, this is the end signal
        if (!sizeRead) {
            bComplete = true;
            return {};
        }

        // We now have the header, read the stream name if it exists
        if (pStreamHeader->dwStreamNameSize) {
            // Read it
            if (ccode = readFile(pStreamHeader->cStreamName,
                                 pStreamHeader->dwStreamNameSize, sizeRead))
                return object.completionCode(ccode);
        }

        // Null terminate it
        pStreamHeader->cStreamName[pStreamHeader->dwStreamNameSize /
                                   sizeof(pStreamHeader->cStreamName[0])] = 0;

        // Grab the suff we need out of the header
        auto streamType =
            (TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE)pStreamHeader->dwStreamId;
        auto streamAttributes = pStreamHeader->dwStreamAttributes;
        // Since we want to know the size of the file in disk we should use
        // findInfo size since pStreamHeader->Size.QuadPart reports the size of
        // the target data for symlinks and it may also report a size of 64 for
        // empty files. Windows API uses two variables to represent file sizes :
        // nFileSizeHigh and nFileSizeLow. They represent the upper 32 bits and
        // lower 32 bits of the file size respectively. By combining these two
        // integers, we can calculate file sizes up to 2 ^ 64 bytes, which is
        // the maximum valid size in the Windows file system.
        auto streamSize = (Qword)findInfo.nFileSizeLow +
                          ((Qword)findInfo.nFileSizeHigh << 32);
        auto streamName = Text(pStreamHeader->cStreamName);
        auto streamOffset = (Qword)0;

        // Setup the default stream begin tag
        const auto pStreamBeginTag = TAG_OBJECT_STREAM_BEGIN::build(
            pTagBuffer, streamType, streamAttributes, &streamName);

        if (streamType ==
            TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_SPARSE_BLOCK) {
            // Read the offset from the stream
            if (ccode = readFile(&streamOffset, sizeof(Qword), sizeRead))
                return object.completionCode(ccode);

            // Less data to read now
            streamSize -= sizeof(Qword);
        }

        // Set the size of the data stream - only necessary on Windows
        pStreamBeginTag->setStreamSize(streamSize);
        pStreamBeginTag->setStreamOffset(streamOffset);

        // Write it
        if ((ccode = pDown->sendTag(target, pStreamBeginTag)) ||
            object.objectFailed())
            return ccode;

        // Return the data size
        type = streamType;
        dataSize = streamSize;
        return {};
    };

    //
    // Renders normal, non-sparse data
    //
    const auto renderStreamData =
        localfcn(TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE streamType,
                 Qword streamSize)
            ->Error {
        Qword offset;
        Dword sizeRead;
        Dword size;

        // Now read the underlying data
        offset = 0;
        while (streamSize) {
            // Get the amount of data we are going to read in this pass
            if (streamSize > MAX_IOSIZE)
                size = MAX_IOSIZE;
            else
                size = (Dword)streamSize;

            // Build the tag
            const auto pDataTag = TAG_OBJECT_STREAM_DATA::build(pTagBuffer);

            // Read the data and set the size we read
            if (ccode = readFile(pDataTag->data.data, size, sizeRead))
                return object.completionCode(ccode);

            pDataTag->setDataSize(sizeRead);

            // Write the data stream
            if ((ccode = pDown->sendTag(target, pDataTag)) ||
                object.objectFailed())
                return ccode;

            // Update the data offset
            offset += sizeRead;

            // Move on
            streamSize -= sizeRead;
        }
        return {};
    };

    //
    // Output end of stream tag
    //
    const auto sendTagEndStream = localfcn()->Error {
        // Create the tag
        const auto streamEndTag = TAG_OBJECT_STREAM_END();

        // Write the stream end tag
        return pDown->sendTag(target, &streamEndTag);
    };

    do {
        // Now this may seem a little convoluted in processing streams, but we
        // do this for a very good reason. The BackupRead API returns everything
        // chunked up into a bunch of WIN32_STREAM_ID structures and data other
        // than the actual file content. This is good because we don't have to
        // call a bunch of APIs to get the other stuff. Essentially, we are
        // going to read a stream header, find its length, convert to a TAG and
        // write the data to the writeTag

        // Open the file
        if (ccode = openFile()) break;

        // Store file metadata
        if ((ccode =
                 sendTagMetadata(target, TAG_OBJECT_METADATA::FLAGS::WINSTREAM,
                                 findInfo, object)) ||
            object.objectFailed())
            break;

        // While we have stuff to read...
        TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE streamType;
        Qword streamSize;
        bool bComplete;

        // Read the WIN32 header and output a BEGIN_STREAM tag
        if ((ccode = sendTagBeginStream(streamType, streamSize, bComplete)) ||
            object.objectFailed())
            break;

        // If we have no more stream headers... done
        if (bComplete) break;

        // Just output the data associated with the stream
        if ((ccode = renderStreamData(streamType, streamSize)) ||
            object.objectFailed())
            break;

        // Output the end stream tag
        if ((ccode = sendTagEndStream()) || object.objectFailed()) break;

    } while (false);

    // If we opened the file
    if (hFile != INVALID_HANDLE_VALUE) {
        // If we have a context
        if (pContext) {
            // Stop the backup
            DWORD bytesRead;
            BackupRead(hFile, nullptr, 0, &bytesRead, true, true, &pContext);
        }

        // Close the file
        CloseHandle(hFile);
    }

    // Return the error
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Callback function for storing encrypted files
///	@param[in]	pbData
///		A pointer to a block of the encrypted file's data to be backed up
///	@param[in]	ulLength
///		The size of the data pointed to by the pbData parameter, in bytes
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::renderEncryptedData(PBYTE pbData,
                                                  ULONG ulLength) noexcept {
    // Define the function to actually render the data
    auto render = localfcn()->Error {
        Error ccode;

        // Write all data
        Qword offset = 0;
        while (ulLength) {
            // Start assuming we can write all of our data
            Dword curSize = ulLength;

            // If we cannot write all of it at once
            if (curSize > MAX_IOSIZE) curSize = MAX_IOSIZE;

            // Get the internal tag buffer
            TAG *pTagBuffer;
            if (ccode = getTagBuffer(&pTagBuffer)) return ccode;

            // Setup the tag
            const auto pEncrypted =
                TAG_OBJECT_STREAM_ENCRYPTED::build(pTagBuffer, curSize);

            // Copy over the data
            memcpy(pEncrypted->data.data, &pbData[offset], curSize);

            // Write the data stream - return just the error code, but we
            // will be preserving the message in pContext->objCode
            if (ccode = pDown->sendTag(opSource.m_target, pEncrypted))
                return ccode;

            // Update offset and remaining
            offset += curSize;
            ulLength -= curSize;
        }

        return ccode;
    };

    // Save the error code if any
    opSource.encrypted.m_pendingError = render();

    // And return it
    return opSource.encrypted.m_pendingError;
}

//-------------------------------------------------------------------------
/// @details
///		Callback function for sotring encrypted files
///	@param[in]	pbData
///		A pointer to a block of the encrypted file's data to be backed up
///	@param[in]	pvCallbackContext
///		A pointer to an application-defined and allocated context block
///	@param[in]	ulLength
///		The size of the data pointed to by the pbData parameter, in bytes
///	@returns
///		A DWORD but we return an error here on failure (gets returned
///		through to the caller)
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
static DWORD WINAPI renderEncryptedDataCallback(PBYTE pbData,
                                                PVOID pvCallbackContext,
                                                ULONG ulLength) noexcept {
    Error ccode;

    // We sent over our this pointer
    auto pThis = (IBaseSysInstance<LvlT> *)pvCallbackContext;

    // Call the encrypted render to process the data into tags
    if (ccode = pThis->renderEncryptedData(pbData, ulLength))
        return ERROR_GEN_FAILURE;
    else
        return ERROR_SUCCESS;
}

//-------------------------------------------------------------------------
/// @details
///		Store an encrypted file (or directory)
///	@param[in]	target
///		The target endpoint to which to send data
///	@param[in]	url
///		The url of the file
///	@param[in]	osPath
///		The fully qualified os path (with \\.\...)
///	@param[in]	findInfo
///		The info we know about the file thus far
///	@param[in]	object
///		The filled in object from the job runner
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::renderEncryptedFile(
    ServicePipe &target, const Text &osPath, const WIN32_FIND_DATAW &findInfo,
    Entry &object) noexcept {
    TAG_OBJECT_STREAM_BEGIN *pStreamBegin;
    void *pSystemContext = nullptr;
    Text streamName = "";
    DWORD status;
    Error ccode;

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if (ccode = getTagBuffer(&pTagBuffer)) return ccode;

    // Set up flags for file export operation
    ULONG flags = 0;

    // Store the objects metadata
    if ((ccode =
             sendTagMetadata(target, TAG_OBJECT_METADATA::FLAGS::WINENCRYPTED,
                             findInfo, object)) ||
        object.objectFailed())
        goto done;

    // Open the file
    if (OpenEncryptedFileRawW(osPath, flags, &opCommon.m_pContext) !=
        ERROR_SUCCESS) {
        // The object itself failed, not the job
        ccode = object.completionCode(
            APERR(GetLastError(), "Unable to open encrypted file"));
        goto done;
    }

    // Write the stream begin tag
    pStreamBegin = TAG_OBJECT_STREAM_BEGIN::build(
        pTagBuffer, TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_DATA, 0,
        &streamName);
    if ((ccode = pDown->sendTag(target, pStreamBegin)) || object.objectFailed())
        goto done;

    // Start reading data
    status = ReadEncryptedFileRaw(renderEncryptedDataCallback<LvlT>, this,
                                  opCommon.m_pContext);

    // Did it fail?
    if (status == ERROR_SUCCESS) {
        // Write the stream end tag
        const auto pStreamEnd = TAG_OBJECT_STREAM_END::build(pTagBuffer);
        ccode = pDown->sendTag(target, pStreamEnd);
    } else {
        // Get the completion code
        ccode = opSource.encrypted.m_pendingError;

        // If the call itself failed
        if (!ccode) {
            // Get the last error code
            ccode = object.completionCode(
                APERR(GetLastError(), "Unable to read encrypted file"));
        }
    }

done:
    // If we opened the file
    if (pSystemContext) {
        // Close it
        CloseEncryptedFileRaw(pSystemContext);
    }

    // Return the error
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
    // Native stream format - read the file and render it into tags
    WIN32_FIND_DATAW findInfo;
    Error ccode;

    // Save this so so the callbacks, if any, can get to it
    opSource.m_target = target;

    // Get the path
    Text osPath;
    if (ccode = Url::osPath(object.url(), osPath)) return ccode;

    // Use FindFirstFile instead of GetFileAttributes/GetFileAttributesEx
    // to get information about reparse points in addition to regular file
    // data
    HANDLE hFile = FindFirstFileW(osPath, &findInfo);

    // If we got an error, return it
    if (hFile == INVALID_HANDLE_VALUE) {
        // Generate the message
        object.completionCode(APERR(GetLastError(), "Unable to find file"));
        return {};
    }

    // Close the find and done
    FindClose(hFile);

    // Restore access time after all readings
    auto restoreGuard = util::Guard{[&]() {
        // Only do this if there is an actual access time
        if (!findInfo.ftLastAccessTime.dwLowDateTime &&
            !findInfo.ftLastAccessTime.dwHighDateTime)
            return;

        DWORD dwAccessMode;
        DWORD dwFlagsAndAttributes;

        // Setup the access mode, flags and attributes for the store operation
        dwAccessMode = FILE_WRITE_ATTRIBUTES | FILE_GENERIC_READ | READ_CONTROL;

        dwFlagsAndAttributes = FILE_FLAG_BACKUP_SEMANTICS |
                               FILE_FLAG_OPEN_NO_RECALL |
                               FILE_FLAG_SEQUENTIAL_SCAN;

        // If this is a reparse point
        if (findInfo.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
            // If it is a junction or symbolic link, backup link not the target
            // data. For more info, see note "<Hard Link, Junctions, and
            // Symbolic links>" at the beginning of this file.
            if (findInfo.dwReserved0 == IO_REPARSE_TAG_APPEXECLINK ||
                findInfo.dwReserved0 == IO_REPARSE_TAG_WCI ||
                findInfo.dwReserved0 == IO_REPARSE_TAG_MOUNT_POINT ||
                findInfo.dwReserved0 == IO_REPARSE_TAG_SYMLINK) {
                dwFlagsAndAttributes |= FILE_FLAG_OPEN_REPARSE_POINT;
            }
        }

        // Open the file
        auto fHandle =
            CreateFileW(osPath, dwAccessMode, FILE_SHARE_READ, nullptr,
                        OPEN_EXISTING, dwFlagsAndAttributes, nullptr);

        // If we have it open
        if (fHandle != INVALID_HANDLE_VALUE) {
            // Restore the original access time
            SetFileTime(fHandle, nullptr, &findInfo.ftLastAccessTime, nullptr);

            // Close the handle
            CloseHandle(fHandle);
        }
    }};

    // Output the begin tag
    if ((ccode = sendTagBeginObject(target)) || object.objectFailed())
        goto done;

    // We need to store an object, but it may be of a type that we have to
    // process with a special set of APIs. We need to determine this now
    if (findInfo.dwFileAttributes & FILE_ATTRIBUTE_ENCRYPTED) {
        ccode = renderEncryptedFile(target, osPath, findInfo, object);
    } else {
        ccode = renderStandardFile(target, osPath, findInfo, object);
    }

    // Clear the up
    opCommon.m_pContext = nullptr;
    opSource.m_target = nullptr;

    // If we had a failure writing to the target, done
    if (ccode || object.objectFailed()) goto done;

    // Output the end tag
    if ((ccode = sendTagEndObject(target, ccode)) || object.objectFailed())
        goto done;

done:
    // Now, if it was the object that failed, then return the no error since
    // it was not the target, and we can continue
    if (ccode && object.objectFailed())
        return {};
    else
        return ccode;
};
}  // namespace engine::store::filter::filesys::base
