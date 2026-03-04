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

#include <engLib/eng.h>

namespace engine::store::filter::filesys::base {
//-----------------------------------------------------------------------------
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
// junction or symbolic link, backup/restore that link, not target data.
// This way anything else will be actual target data including windows deduped
// files.
//-----------------------------------------------------------------------------

//-----------------------------------------------------------------------------
/// @details
///		Recover metadata using a file handle
///	@param[in]	hFile
///		Handle to the file
///	@param[in]	path
///		The path to the file
///	@returns
///		Error
//-----------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::setSparse(const Url &url,
                                        const HANDLE hFile) noexcept {
    // If we already set it on this file, done
    if (opTarget.m_hasSetSparse) return {};

    // Setup to sparse
    DWORD bytesReturned;

    // Do the deviceIO call
    BOOL bRet = DeviceIoControl(hFile, FSCTL_SET_SPARSE, nullptr, 0, nullptr, 0,
                                &bytesReturned, nullptr);

    // Say we at least tried to set it
    opTarget.m_hasSetSparse = true;

    // If we couldn't do it
    if (bRet == FALSE)
        MONERR(warning, GetLastError(), "Unable to set file to sparse",
               (TextView)url);

    // And done
    return {};
}

//-----------------------------------------------------------------------------
/// @details
///		Recover metadata using a file handle
///	@param[in]	url
///		The url of the file (so we can output)
///	@param[in]	osPath
///		The text os path
///	@param[in]	hFile
///		Handle to the file
///	@returns
///		Error
//-----------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::setMetadata(const Url &url, const Text &osPath,
                                          const HANDLE hFile) noexcept {
    // If we have windows info
    if (m_metadata.isMember("windows")) {
        const auto windows = m_metadata["windows"];

        // Set normal file attributes
        SetFileAttributesW(osPath, opTarget.m_attributes);

        // If this is the compressed attributed
        if (opTarget.m_attributes & FILE_ATTRIBUTE_COMPRESSED) {
            // Setup to compress
            USHORT compressionState = COMPRESSION_FORMAT_DEFAULT;
            DWORD bytesReturned;

            // Do the deviceIO call
            BOOL bRet = DeviceIoControl(
                hFile, FSCTL_SET_COMPRESSION, &compressionState,
                sizeof(compressionState), nullptr, 0, &bytesReturned, nullptr);

            // If we couldn't do it
            if (bRet == FALSE)
                MONERR(warning, GetLastError(),
                       "Unable to set file to compressed", (TextView)url);
        }
    }

    // If the source object metadata has times
    // We are recovering non-Windows files so use the generic timestamp data
    // available
    auto getFileTime = [&](TextView timeName, FILETIME &value) -> FILETIME * {
        if (m_metadata.isMember(timeName)) {
            value = _tr<FILETIME>(time::fromTimeT<time::SystemStamp>(
                m_metadata[timeName].asUInt64()));
            return &value;
        }
        return nullptr;
    };
    FILETIME access, modify, create;
    SetFileTime(hFile, getFileTime("createTime", create),
                getFileTime("accessTime", access),
                getFileTime("modifyTime", modify));

    // And done
    return {};
}

//-----------------------------------------------------------------------------
/// @details
///		Recover metadata using a path
///	@param[in]	url
///		The url of the file (so we can output)
///	@param[in]	osPath
///		The text os path
///	@returns
///		Error
//-----------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::setMetadata(const Url &url,
                                          const Text &osPath) noexcept {
    Error ccode;

    // Open file
    HANDLE hFile = CreateFileW(
        osPath, FILE_GENERIC_WRITE | FILE_GENERIC_READ, FILE_SHARE_READ,
        nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);

    // If we coudn't open it, error out
    if (hFile == INVALID_HANDLE_VALUE)
        return Error(
            GetLastError(), _location,
            "CNF: Unable to open file {} to set attributes and timestamps",
            (TextView)url);

    // Call overloaded function which works on given file handle
    ccode = setMetadata(url, osPath, hFile);

    // Close the file
    CloseHandle(hFile);

    // And done
    return ccode;
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
///	@param[in]	osPath
///		the full path name
/// @returns
///		Error
//-----------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::createStandardFile(const Url &url) noexcept {
    DWORD dwFlagsAndAttributes;
    DWORD dwAccessMode;
    DWORD dwShareMode;
    HANDLE hFile;
    Error ccode;

    // Get the os based path
    Text osPath;
    if (ccode = Url::osPath(url, osPath)) return ccode;

    // Setup the access mode, flags and attributes for restoring a file
    dwAccessMode = FILE_GENERIC_WRITE | FILE_GENERIC_READ | READ_CONTROL |
                   WRITE_DAC | WRITE_OWNER | SYNCHRONIZE;

    // This flag was passed over in FPI but is apparently not needed here
    // since we are using backup semantics and we are not read/writing
    // the SACL directly
    //	ACCESS_SYSTEM_SECURITY;

    dwFlagsAndAttributes = FILE_FLAG_OPEN_NO_RECALL | FILE_FLAG_SEQUENTIAL_SCAN;

    // If the source system was windows, then we used backup semantics
    // so open it with backup semantics here. Otherwise, we just create
    // the file and write to it
    if (opTarget.m_metadataFlags & TAG_OBJECT_METADATA::FLAGS::WINSTREAM)
        dwFlagsAndAttributes |= FILE_FLAG_BACKUP_SEMANTICS;

    // We are recovering file, prevent other processes from opening a file
    dwShareMode = 0;
    hFile = CreateFileW(osPath, dwAccessMode, dwShareMode, nullptr,
                        CREATE_ALWAYS, dwFlagsAndAttributes, nullptr);

    // If we could not open the file and it was due to the path not there
    if (hFile == INVALID_HANDLE_VALUE &&
        GetLastError() == ERROR_PATH_NOT_FOUND) {
        // Create it and try to open again
        if (ccode = createParentPath(url)) return ccode;

        // Attempt the open again
        hFile = CreateFileW(osPath, dwAccessMode, dwShareMode, nullptr,
                            CREATE_ALWAYS, dwFlagsAndAttributes, nullptr);
    }

    // If we could not open the file and it was due to the path not there
    if (hFile == INVALID_HANDLE_VALUE &&
        GetLastError() == ERROR_ACCESS_DENIED) {
        // Create it and try to open again
        DeleteFileW(osPath);

        // Attempt the open again
        hFile = CreateFileW(osPath, dwAccessMode, dwShareMode, nullptr,
                            CREATE_ALWAYS, dwFlagsAndAttributes, nullptr);
    }

    // If we couldn't create it...
    if (hFile == INVALID_HANDLE_VALUE)
        return APERRT(GetLastError(), "Unable to create file", (TextView)url);

    opTarget.m_hFile = hFile;
    return {};
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
Error IBaseSysInstance<LvlT>::storeEncryptedData(PBYTE pbData,
                                                 PULONG pulLength) noexcept {
    LOGT("Encrypted writer thread waiting for data");

    // Wait for a buffer to come in
    opTarget.encrypted.m_pEncryptBufferReady->wait();

    // When the end object tag is receives, it wakes us up without
    // any encrypt buffer to send over, which is our indication
    // we are done
    if (!opTarget.encrypted.m_pEncryptBuffer) {
        LOGT("Encrypted writer thread received end of data");

        *pulLength = 0;
        return {};
    }

    // Get the size of the buffer remaining
    Dword size = opTarget.encrypted.m_encryptBufferSize;

    LOGT("Encrypted writer thread waiting got data of {}",
         opTarget.encrypted.m_encryptBufferSize);

    // If we are restricted on how much we can write
    if (size > *pulLength) size = *pulLength;

    // Copy the data over
    memcpy(pbData,
           &opTarget.encrypted
                .m_pEncryptBuffer[opTarget.encrypted.m_encryptBufferOffset],
           size);

    // Update the offset and size
    opTarget.encrypted.m_encryptBufferOffset += size;
    opTarget.encrypted.m_encryptBufferSize -= size;

    // If we are completed, then notify the tag processor we
    // are ready for another tag buffer, otherwise we still
    // have data to process in this wait, wait for the encryption
    // api to call us again in which case we will wake up immediately
    if (!opTarget.encrypted.m_encryptBufferSize)
        opTarget.encrypted.m_pEncryptBufferComplete->notify();
    else
        opTarget.encrypted.m_pEncryptBufferReady->notify();

    // Save the size we are returning
    *pulLength = size;

    LOGT("Encrypted writer thread returned data of size {}", size);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Callback function for sotring encrypted files
///	@param[in]	pbData
///		A pointer to a block of the encrypted file's data to be backed up
///	@param[in]	pvCallbackContext
///		A pointer to an application-defined and allocated context block
///	@param[inout]	pulLength
///		The size of the data pointed to by the pbData parameter, in bytes
///	@returns
///		A DWORD but we return an error here on failure (gets returned
///		through to the caller)
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
static DWORD WINAPI storeEncryptedDataCallback(PBYTE pbData,
                                               PVOID pvCallbackContext,
                                               PULONG pulLength) noexcept {
    // We sent over our this pointer
    auto pThis = (IBaseSysInstance<LvlT> *)pvCallbackContext;

    // Read the data sent to us in the buffer - any failures should be
    // saved in the storeEncryptedData in the m_pendingError member
    // and returned here se we can terminate
    if (pThis->storeEncryptedData(pbData, pulLength))
        return ERROR_GEN_FAILURE;
    else
        return ERROR_SUCCESS;
}

//-----------------------------------------------------------------------------
/// @details
///		Recover encrypted file (or directory)
///	@param[in]	url
///		Url of the encrypted file
//-----------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::createEncryptedFile(const Url &url) noexcept {
    Error ccode;
    DWORD flags = 0;
    DWORD status;

    // Get the os based path
    Text osPath;
    if (auto ccode = Url::osPath(url, osPath)) return ccode;

    // This is a write thread that will sit and wait on the
    // m_encryptBufferWrite condition which is signalled
    // when a TAG_OBJECT_DATA_ENCRYPT buffer comes in to write
    auto writerThread = [this]() -> void {
        Error ccode;
        DWORD status;

        LOGT("Created encrypted writer thread");

        // Start writing data - this will hang until m_pEncryptBuffer is cleared
        // and the thread is signalled
        status = WriteEncryptedFileRaw(storeEncryptedDataCallback<LvlT>, this,
                                       opCommon.m_pContext);

        // We were notified that this ended, so signal the main tag thread that
        // we are done
        opTarget.encrypted.m_pEncryptBufferComplete->notify();

        // Did it fail?
        if (status != ERROR_SUCCESS) {
            // Get the completion code
            ccode = opTarget.encrypted.m_pendingError;

            // If the call itself failed
            if (!ccode) {
                // Get the last error code
                ccode = APERR(GetLastError(), "Unable to write encrypted file");
            }
        }

        LOGT("Encrypted writer thread completed with {}", ccode);
    };

    // Make sure the parent directory exists
    if (ccode = createParentPath(url)) return ccode;

    // Set up flags for file import operation
    flags = CREATE_FOR_IMPORT;

    // If this is a hidden file, create it as such
    if (opTarget.m_attributes & FILE_ATTRIBUTE_HIDDEN)
        flags |= OVERWRITE_HIDDEN;

    // Open the file
    status = OpenEncryptedFileRawW(osPath, flags, &opCommon.m_pContext);
    if (status) {
        // Get the last error code
        ccode =
            APERRT(status, "Unable to create encrypted file", (TextView)url);
        return ccode;
    }

    // Setup our semaphores and the thread
    opTarget.encrypted.m_pEncryptBufferReady = new Semaphore();
    opTarget.encrypted.m_pEncryptBufferComplete = new Semaphore();
    opTarget.encrypted.m_pEncryptThread = new Thread(_location, "encryptWrite");
    opTarget.encrypted.m_pEncryptThread->start(writerThread);

    // If it failed, stop
    if (status != ERROR_SUCCESS) {
        // Get the pending error
        ccode = opTarget.encrypted.m_pendingError;

        // If we don't have it, the call itself failed, so generate and error
        if (!ccode) {
            // Get the last error code
            ccode = APERRT(GetLastError(), "Unable to write encrypted file",
                           (TextView)url);
        }
    }

    return ccode;
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
    Error ccode;

    // If this is a Windows stream, we process via the BackupWrite API
    if (opTarget.m_metadataFlags & TAG_OBJECT_METADATA::FLAGS::WINSTREAM) {
        // Let windows deal with all streams, send over the stream
        opTarget.m_streamEnabled = true;

        // Send the header over to BackupWrite
        DWORD bytesWritten;

        // Allocate a working buffer to build the WIN32_STREAM_ID into
        Byte buffer[16384];
        const auto pStreamHeader = (WIN32_STREAM_ID *)buffer;

        // Get the stream name as a in Utf16 format
        Utf16 streamName = pTag->data.streamName;

        const auto nameSize = (DWORD)Utf16len(streamName);

        // Fill in the stream header to send to Windows
        pStreamHeader->dwStreamId = pTag->data.streamType;
        pStreamHeader->dwStreamAttributes = pTag->data.streamAttributes;
        pStreamHeader->Size.QuadPart = pTag->data.streamSize;
        pStreamHeader->dwStreamNameSize =
            nameSize * sizeof(pStreamHeader->cStreamName[0]);
        Utf16cpy(pStreamHeader->cStreamName, nameSize + 1, streamName);

        // Determine how big the header to write is
        DWORD headerSize = offsetof(WIN32_STREAM_ID, cStreamName) +
                           pStreamHeader->dwStreamNameSize;

        // If this is a sparse block, add back in the size of the offset
        // we are going to write first
        if (pTag->data.streamType ==
            TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_SPARSE_BLOCK)
            pStreamHeader->Size.QuadPart += sizeof(Qword);

        // Write it
        if (!BackupWrite(opTarget.m_hFile, (BYTE *)pStreamHeader, headerSize,
                         &bytesWritten, FALSE, opCommon.m_processSecurity,
                         &opCommon.m_pContext))
            return APERRT(::GetLastError(),
                          "BackupWrite failed while writing the stream header");

        // If this is a sparse block, we must write the offset
        // as the first thing after the stream header
        if (pTag->data.streamType ==
            TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_SPARSE_BLOCK) {
            if (!BackupWrite(opTarget.m_hFile, (BYTE *)&pTag->data.streamOffset,
                             sizeof(Qword), &bytesWritten, FALSE,
                             opCommon.m_processSecurity, &opCommon.m_pContext))
                return APERRT(
                    ::GetLastError(),
                    "BackupWrite failed while writing the stream offset");
        }

        // The data will come in via the TAG_OBJECT_STREAM_DATA tag
        return {};
    }

    // This is from a Windows encrypted file
    if (opTarget.m_metadataFlags & TAG_OBJECT_METADATA::FLAGS::WINENCRYPTED) {
        // Disable the TAG_OBJECT_STREAM_DATA tags... We don't use them
        // for this type
        opTarget.m_streamEnabled = false;

        // The data will come in via the TAG_OBJECT_STREAM_ENCRYPTED tag
        return {};
    }

    // Get the name of this stream
    Text streamName = Text(pTag->data.streamName);

    // This is a standard file probably from Linux, or a different node
    // so, just save what is in the data stream or the sparse block stream
    // If this is data or sparse data, write the stream
    // otherwise it will be ignored
    opTarget.m_streamEnabled = false;

    // If this is the unnamed, primary data stream
    if (!streamName.length()) {
        // And this is either DATA or SPARSE data, then write it
        // using the WriteFile interface
        if (pTag->data.streamType ==
            TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_DATA) {
            // Enable the actual data type data streams
            opTarget.m_streamEnabled = true;
        } else if (pTag->data.streamType ==
                   TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_SPARSE_BLOCK) {
            // Enable the sparse data type data streams
            opTarget.m_streamEnabled = true;

            // Set the sparse attribute
            ccode = setSparse(m_targetObjectUrl, opTarget.m_hFile);
        } else {
            // Ignore all others
            opTarget.m_streamEnabled = false;
        }
    }

    // Save the offset
    opTarget.m_dataOffset = pTag->data.streamOffset;
    return ccode;
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
    DWORD bytesWritten;

    // This happens if we are not restoring a windows file and
    // it is a non-data or non-sparse data stream - see processObjectStreamBegin
    // to determine if a stream is enabled or not
    if (!opTarget.m_streamEnabled) return {};

    // Determine which API to call
    if (opTarget.m_metadataFlags & TAG_OBJECT_METADATA::FLAGS::WINSTREAM) {
        // Send the header over to BackupWrite
        if (!BackupWrite(opTarget.m_hFile, (BYTE *)pTag->data.data, pTag->size,
                         &bytesWritten, FALSE, opCommon.m_processSecurity,
                         &opCommon.m_pContext))
            return APERR(::GetLastError(), "BackupWrite failed");
    } else {
        LARGE_INTEGER pos;
        pos.QuadPart = opTarget.m_dataOffset;

        // Set the file pointer
        if (SetFilePointer(opTarget.m_hFile, pos.LowPart, &pos.HighPart,
                           SEEK_SET) == INVALID_SET_FILE_POINTER)
            return APERRT(::GetLastError(), "Unable to set file pointer to",
                          opTarget.m_dataOffset);

        // Write the file directly
        if (!WriteFile(opTarget.m_hFile, (BYTE *)&pTag->data.data, pTag->size,
                       &bytesWritten, nullptr))
            return APERRT(::GetLastError(), "WriteFile failed");

        // Update for the next write
        opTarget.m_dataOffset += pTag->size;
    }

    // Check it
    if (bytesWritten != pTag->size)
        return APERR(Ec::Failed,
                     "Could not write the requested number of bytes");

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
Error IBaseSysInstance<LvlT>::processObjectStreamEncrypted(
    TAG_OBJECT_STREAM_ENCRYPTED *pTag) noexcept {
    // Setup our data ptr
    opTarget.encrypted.m_pEncryptBuffer = pTag->data.data;
    opTarget.encrypted.m_encryptBufferSize =
        pTag->size - offsetof(TAG_OBJECT_STREAM_ENCRYPTED::DATA, data);
    opTarget.encrypted.m_encryptBufferOffset = 0;

    // Signal that the buffer is ready
    opTarget.encrypted.m_pEncryptBufferReady->notify();

    // Wait for the processing of the buffer to complete
    opTarget.encrypted.m_pEncryptBufferComplete->wait();
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Proesses an object stream end header
///	@param[in]	pTag
///		The stream begin tag
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::processObjectStreamEnd(
    TAG_OBJECT_STREAM_END *pTag) noexcept {
    // Just clear the stream enabled flag
    opTarget.m_streamEnabled = false;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Proesses the metadata saved with the object. A lot of things cannot
///		be done until we have this metadata which should be pretty much the
///		first thing in the tag stream. For example, we don't know if we
///		are writing a Windows encrypted file or a standard file, nor
///		whether we are going to use WriteFile or BackupWrite
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
    opTarget.m_metadataFlags = m_metadata["flags"].asUInt();

    // Grab the file attributes
    if (m_metadata.isMember("windows"))
        opTarget.m_attributes = m_metadata["windows"]["attributes"].asUInt();
    else
        opTarget.m_attributes = 0;

    // Is this a Windows encrypted file?
    if (opTarget.m_metadataFlags & TAG_OBJECT_METADATA::FLAGS::WINENCRYPTED) {
        // Create an encrypted file and begin it's thread to start
        // waiting on data to come in
        if (ccode = createEncryptedFile(m_targetObjectUrl)) return ccode;
    } else {
        // Create a file - will be for either standard WriteFile or
        // BackupWrite based on the TAG_METADATA::WINSTREAM flag
        if (ccode = createStandardFile(m_targetObjectUrl)) return ccode;
    }

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
    if (ccode = endpoint->mapPath(entry.url(), m_targetObjectUrl)) return ccode;

    // Call the parent
    return Parent::open(entry);
}

//-------------------------------------------------------------------------
/// @details
///		Process and write a tag
///	@param[in]	entry
///		The object info from the input pipe
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
            ccode = processObjectStreamBegin(&pTagData->streamBegin);
            break;
        }

        case TAG_OBJECT_STREAM_DATA::ID: {
            // Write stream data
            ccode = processObjectStreamData(&pTagData->streamData);
            break;
        }

        case TAG_OBJECT_STREAM_ENCRYPTED::ID: {
            // Write encrypted stream data
            ccode = processObjectStreamEncrypted(&pTagData->streamEncrypted);
            break;
        }

        case TAG_OBJECT_STREAM_END::ID: {
            // Write stream data
            ccode = processObjectStreamEnd(&pTagData->streamEnd);
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
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseSysInstance<LvlT>::close() noexcept {
    Text osPath;
    if (auto ccode = Url::osPath(m_targetObjectUrl, osPath)) return ccode;

    // Is this a Windows encrypted file?
    if (opTarget.m_metadataFlags & TAG_OBJECT_METADATA::FLAGS::WINENCRYPTED) {
        if (opTarget.encrypted.m_pEncryptThread) {
            // Signal to the open thread that we are done
            opTarget.encrypted.m_pEncryptBuffer = nullptr;

            // Signal that the buffer is ready - which will end
            // the thread
            opTarget.encrypted.m_pEncryptBufferReady->notify();

            // Wait for the processing to complete
            opTarget.encrypted.m_pEncryptBufferComplete->wait();
        }

        // Close the handle
        if (opCommon.m_pContext) CloseEncryptedFileRaw(opCommon.m_pContext);

        // Return any pending error we got
        if (opTarget.encrypted.m_pendingError)
            currentEntry->completionCode(opTarget.encrypted.m_pendingError);

        // If we didn't have any error, set the metadata
        if (!currentEntry->objectFailed()) {
            if (auto ccode = setMetadata(m_targetObjectUrl, osPath))
                currentEntry->completionCode(ccode);
        }
    } else {
        // If we didn't have any error, set the metadata
        if (!currentEntry->objectFailed()) {
            if (auto ccode =
                    setMetadata(m_targetObjectUrl, osPath, opTarget.m_hFile))
                currentEntry->completionCode(ccode);
        }
    }

    // Close the file
    if (opTarget.m_hFile != INVALID_HANDLE_VALUE) CloseHandle(opTarget.m_hFile);

    if (!currentEntry->objectFailed()) {
        // update current entry with actual size
        auto statOr = ap::file::stat(osPath, true);
        if (statOr.hasCcode())
            currentEntry->completionCode(statOr.ccode());
        else
            currentEntry->size(statOr->size);
    }

    // Clean everything up and reset the state
    // for the next object coming in
    opCommon.m_pContext = nullptr;
    opTarget.m_streamEnabled = false;
    opTarget.m_metadataFlags = 0;
    opTarget.m_dataOffset = 0;
    opTarget.m_hFile = INVALID_HANDLE_VALUE;
    opTarget.m_hasSetSparse = false;
    opTarget.encrypted.m_encryptBufferOffset = 0;
    opTarget.encrypted.m_encryptBufferOffset = 0;
    opTarget.encrypted.m_pendingError = {};

    if (opTarget.encrypted.m_pEncryptThread) {
        opTarget.encrypted.m_pEncryptThread->stop();
        delete opTarget.encrypted.m_pEncryptThread;
        opTarget.encrypted.m_pEncryptThread = nullptr;
    }

    if (opTarget.encrypted.m_pEncryptBufferComplete) {
        delete opTarget.encrypted.m_pEncryptBufferComplete;
        opTarget.encrypted.m_pEncryptBufferComplete = nullptr;
    }

    if (opTarget.encrypted.m_pEncryptBufferReady) {
        delete opTarget.encrypted.m_pEncryptBufferReady;
        opTarget.encrypted.m_pEncryptBufferReady = nullptr;
    }

    return Parent::close();
}
}  // namespace engine::store::filter::filesys::base
