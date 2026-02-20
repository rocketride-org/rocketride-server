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
//	The class definition for Windows file system node
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store::filter::filesys::base {
template <log::Lvl LvlT>
class IBaseSysGlobal;

//-------------------------------------------------------------------------
/// @details
///		Define the instance class for this filter
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
class IBaseSysInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;
    using FileScanner = file::FileScanner;
    using FileStream = file::stream::Stream<file::stream::File>;

    using Semaphore = ap::async::Semaphore;
    using Thread = ap::async::Thread;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = LvlT;

    //-----------------------------------------------------------------
    /// @details
    ///		Begins operations on this filter. Sets up commonly used members
    ///	@param[in]	mode
    ///		Mode that endpoint is opened in
    ///	@returns
    ///		Error
    //-----------------------------------------------------------------
    virtual Error beginFilterInstance() noexcept override;

    virtual Error open(Entry &entry) noexcept override;
    virtual Error writeTag(const TAG *pTag) noexcept override;
    virtual Error close() noexcept override;

    virtual Error checkChanged(Entry &object) noexcept override;
    virtual Error renderObject(ServicePipe &target,
                               Entry &object) noexcept override;

public:
    //-----------------------------------------------------------------
    /// @details
    ///		Must be public so the the static WINAPI can call it
    //-----------------------------------------------------------------
    Error renderEncryptedData(PBYTE pbData, ULONG ulLength) noexcept;
    Error storeEncryptedData(PBYTE pbData, PULONG pulLength) noexcept;

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		Private functions used for store
    //-----------------------------------------------------------------
    Error createParentPath(const Url &url) noexcept;
    Error createStandardFile(const Url &url) noexcept;
    Error createEncryptedFile(const Url &url) noexcept;
    Error setSparse(const Url &url, const HANDLE hFile) noexcept;
    Error setMetadata(const Url &url, const Text &osPath,
                      const HANDLE hFile) noexcept;
    Error setMetadata(const Url &url, const Text &osPath) noexcept;
    Error processObjectStreamBegin(TAG_OBJECT_STREAM_BEGIN *pTag) noexcept;
    Error processObjectStreamData(TAG_OBJECT_STREAM_DATA *pTag) noexcept;
    Error processObjectStreamEncrypted(
        TAG_OBJECT_STREAM_ENCRYPTED *pTag) noexcept;
    Error processObjectStreamEnd(TAG_OBJECT_STREAM_END *pTag) noexcept;
    Error processMetadata(TAG_OBJECT_METADATA *pTag) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Private functions used for render
    //-----------------------------------------------------------------
    Error sendTagMetadata(ServicePipe &target,
                          TAG_OBJECT_METADATA::FLAGS metadataFlags,
                          const WIN32_FIND_DATAW &findInfo,
                          Entry &object) noexcept;
    Error renderStandardFile(ServicePipe &target, const Text &osPath,
                             const WIN32_FIND_DATAW &findInfo,
                             Entry &object) noexcept;
    Error renderEncryptedFile(ServicePipe &target, const Text &osPath,
                              const WIN32_FIND_DATAW &findInfo,
                              Entry &object) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Private functions used to stat the object
    //-----------------------------------------------------------------
    static bool isFileMovedOrUnavailable(const Error &err) noexcept;

    //-------------------------------------------------------------------------
    /// @details
    ///		Checks whether the file exists, and should be replaced if exists.
    ///     Is overriden in the derived class
    ///	@returns
    ///		Error
    //-------------------------------------------------------------------------
    virtual Error isObjectUpdateNeeded(const Url &url) noexcept = 0;

    //=================================================================
    // These are common members which are utilized by render/store/data
    //=================================================================
    struct {
        //-------------------------------------------------------------
        /// @details
        ///		Set to process security info on reading/writing files
        //-------------------------------------------------------------
        bool m_processSecurity = false;

        //-------------------------------------------------------------
        /// @details
        ///		Context return from BackupWrite/BackupRead, and for
        ///		encrypted read/write
        //-------------------------------------------------------------
        void *m_pContext = nullptr;
    } opCommon;

    //=================================================================
    // The are members that are used for render operations
    //=================================================================
    struct {
        //-------------------------------------------------------------
        /// @details
        ///		current target used for BackupWrite and Encrypted callback
        //-------------------------------------------------------------
        ServicePipe m_target;

        //=============================================================
        // The are members that are used for rendering encrypted files
        //=============================================================
        struct {
            //---------------------------------------------------------
            ///	@details
            ///		The error code for the encrypted file system reader
            //---------------------------------------------------------
            Error m_pendingError;
        } encrypted;
    } opSource;

    //-------------------------------------------------------------
    /// @details
    ///		Metadata information - set when the TAG_OBJECT_METDATA
    ///		comes through
    //-------------------------------------------------------------
    json::Value m_metadata;
    //=================================================================
    // The are members that are used for store operations
    //=================================================================
    struct {
        //-------------------------------------------------------------
        /// @details
        ///		Have we set the sparse attribute yet?
        //-------------------------------------------------------------
        bool m_hasSetSparse = false;

        //-------------------------------------------------------------
        /// @details
        ///		Handle to file on write
        //-------------------------------------------------------------
        HANDLE m_hFile = INVALID_HANDLE_VALUE;

        //-------------------------------------------------------------
        /// @details
        ///		Offset to which to write data
        //-------------------------------------------------------------
        Qword m_dataOffset = 0;

        //-------------------------------------------------------------
        /// @details
        ///		Flags from the metadata
        //-------------------------------------------------------------
        Dword m_metadataFlags = 0;

        //-------------------------------------------------------------
        /// @details
        ///		Attributes from the metadata.windows.attributes if they
        ///		are present
        //-------------------------------------------------------------
        Dword m_attributes = 0;

        //-------------------------------------------------------------
        /// @details
        ///		Once we get a stream begin header, determine if the
        ///		following is to be thrown away since we don't understand
        ///		it
        //-------------------------------------------------------------
        bool m_streamEnabled;

        //=============================================================
        // The are members that are used for storing encrypted files
        //=============================================================
        struct {
            //---------------------------------------------------------
            ///	@details
            ///		Background thread to write the encrypted content
            //---------------------------------------------------------
            Thread *m_pEncryptThread = nullptr;

            //---------------------------------------------------------
            ///	@details
            ///		Pointer to the encryption buffer
            //---------------------------------------------------------
            Byte *m_pEncryptBuffer = nullptr;

            //---------------------------------------------------------
            ///	@details
            ///		Semaphore to indicate to the encryption thread the
            ///		m_pEncryptBuffer is ready to be sent to Windows
            //---------------------------------------------------------
            Semaphore *m_pEncryptBufferReady = nullptr;

            //---------------------------------------------------------
            ///	@details
            ///		Semaphore to to the main thread that the encrpytion
            ///		thread has returned all data in the buffer to Windows
            //---------------------------------------------------------
            Semaphore *m_pEncryptBufferComplete = nullptr;

            //---------------------------------------------------------
            ///	@details
            ///		Offset of the buffer to return. This happens if we get
            ///		a larger buffer in m_pEncryptBuffer than Windows can
            ///		read in a single chunk
            //---------------------------------------------------------
            Dword m_encryptBufferOffset = 0;

            //---------------------------------------------------------
            ///	@details
            ///		Size of data remaining in the m_pEncryptBuffer to
            ///		return to Windows
            //---------------------------------------------------------
            Dword m_encryptBufferSize = 0;

            //---------------------------------------------------------
            ///	@details
            ///		The error code for the encrypted file system writer
            //---------------------------------------------------------
            Error m_pendingError;
        } encrypted;
    } opTarget;
};

//-------------------------------------------------------------------------
/// @details
///		Define the common class for this filter
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
class IBaseSysGlobal : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = LvlT;
};

//-------------------------------------------------------------------------
/// @details
///		Define the endpoint
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
class IBaseSysEndpoint : public IServiceEndpoint {
public:
    using Config = IServiceConfig;
    using Parent = IServiceEndpoint;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = LvlT;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Type = LvlT == log::Lvl::ServiceFilesys ? "filesys"_tv
                       : LvlT == log::Lvl::ServiceSmb   ? "smb"_tv
                                                        : "<unknown>"_tv;

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error scanObjects(Path &path,
                              const ScanAddObject &callback) noexcept override;

protected:
    //----------------------------------------------------------------
    /// @details
    ///		Special value for file systems read from the
    ///		service.parameters.excludeExternalDrives
    //-----------------------------------------------------------------
    bool m_excludeExternalDrives = true;

    //----------------------------------------------------------------
    /// @details
    ///		service.parameters.excludeSymlinks
    //-----------------------------------------------------------------
    bool m_excludeSymlinks = true;

    //----------------------------------------------------------------
    /// @details
    ///		A set of hashes of scanned dicectories/symlinks
    ///		to prevent re-scanning
    //-----------------------------------------------------------------
    std::unordered_set<int32_t> m_scannedEntries;
    async::MutexLock m_scannedEntriesLock;

private:
    //-----------------------------------------------------------------
    // We must have these implemented
    //-----------------------------------------------------------------
    Error processEntry(Path &parentPath, WIN32_FIND_DATAW &findInfo,
                       Path &objectPath, Entry &object,
                       const ScanAddObject &addObject) noexcept;
    Error loadRoots(Path &objectPath, Entry &object,
                    const ScanAddObject &addObject) noexcept;
};
}  // namespace engine::store::filter::filesys::base
