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

#pragma once

namespace engine::stream::zipbase {
//-------------------------------------------------------------------------
/// @details
///		Define the actual stream interface for the zipfile://
///		endpoint. This endpoint/stream uses a main open (or create) and
///		utilizes open/write/closeSubStream functions to mark the items
///		within the zip file
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
class ZipBase : public iStream {
public:
    using Parent = iStream;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = LvlT;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    ZipBase() noexcept {}
    virtual ~ZipBase() {}

    //---------------------------------------------------------------------
    // Public API
    //---------------------------------------------------------------------

    //-----------------------------------------------------------------
    /// @details
    ///		Open the stream in the given mode. This must be implemented
    ///		by the actual class implementation
    ///	@param[in] url
    ///		The url to open
    ///	@param[in] mode
    ///		The mode to open in
    //-----------------------------------------------------------------
    Error open(const Url &url, stream::Mode mode) override = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		Open a substream of the main stream
    /// @param[in]	entry
    ///		The entry being processed
    ///	@param[in]	targetUrl
    ///		The actual name within to call the target
    ///	@param[out]	ppContext
    ///		Recieves some kind of ptr to a context
    //-----------------------------------------------------------------
    Error openSubStream(const Entry &entry, const Url &targetUrl,
                        void *&pContext) noexcept override {
        LOGT("Opening zip substream", (TextView)targetUrl);

        // Lock the mutex
        m_mutex.lock();

        // Set it to somethine other than null ptr
        pContext = (void *)"";

        // Build up the zip info
        zip_fileinfo info{.mz_dos_date = (uint32_t)entry.modifyTime()};

        file::Path path;
        if (auto ccode = Url::toPath(targetUrl, path)) return ccode;

        // Get it as a string
        Text targetPath = (TextView)path;

        // Open the file within the zip
        //		int zipOpenNewFileInZip5(
        // 			zipFile file,
        // 			const char *filename,
        // 			const zip_fileinfo *zipfi,
        // 			const void *extrafield_local, uint16_t
        // size_extrafield_local, 			const void *extrafield_global, uint16_t
        // size_extrafield_global, 			const char *comment, 			int compression_method,
        // 			int level,
        // 			int raw,
        // 			int windowBits,
        // 			int memLevel,
        // 			int strategy,
        // 			const char *password,
        // 			unsigned long crc_for_crypting,
        // 			unsigned long version_madeby,
        // 			unsigned long flag_base,
        // 			int zip64)
        auto res =
            zipOpenNewFileInZip5(m_zipFile,              // zip control
                                 targetPath.c_str(),     // filename
                                 &info,                  // zip file info
                                 NULL, 0,                // local
                                 NULL, 0,                // global
                                 NULL,                   // comment
                                 Z_DEFLATED,             // compression method
                                 Z_DEFAULT_COMPRESSION,  // compression level
                                 0,                      // raw
                                 0,                      // windows bits
                                 0,                      // mem level
                                 0,                      // strategy
                                 NULL,                   // password
                                 0,                      // crc
                                 0,                      // madeby
                                 MZ_ZIP_FLAG_UTF8,       // utf8 filename
                                 (entry.size() > 0xffffffff) ? 1 : 0);  // is 64

        // If we failed, unlock the mutex and error out
        if (res != Z_OK) {
            // Unlock the mutex
            m_mutex.unlock();

            // Get the pending error if there was one
            return getError(res);
        }

        // Done
        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Write the data to the substream
    /// @param[in]	data
    ///		Data to write
    //-----------------------------------------------------------------
    void writeSubStream(void *&pContext,
                        InputData data) noexcept(false) override {
        LOGT("Writing zip substream", Size(data.size()));

        // If we are not open, ignore this
        if (!pContext) return;

        // If no data, done
        if (!data.size()) return;

        // Write it
        auto res =
            zipWriteInFileInZip(m_zipFile, data.data(), (uint32_t)data.size());

        // Check to make sure we wrote it
        if (res != ZIP_OK) {
            // Close the zip file
            zipCloseFileInZip(m_zipFile);

            // Throw the error
            throw getError(res);
        }
        return;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Closes the substream
    ///	@param[in]	hStream
    ///		Handle to the substream
    /// @param[in]	graceful
    ///		Is this a graceful exit, or just terminate
    //-----------------------------------------------------------------
    void closeSubStream(void *&pContext,
                        bool graceful) noexcept(false) override {
        LOGT("Close zip substream");

        // If we are not open, ignore this
        if (!pContext) return;

        // Close it
        zipCloseFileInZip(m_zipFile);

        // Clear our context
        pContext = nullptr;

        // And unlock for other streams to write a file
        m_mutex.unlock();
        return;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Close the stream
    //-----------------------------------------------------------------
    void close(bool graceful) noexcept(false) override {
        LOGT("Closing zipfile");

        // Close the zip
        auto res = zipClose(m_zipFile, NULL);

        // Check to make sure we closed it
        if (res != ZIP_OK) throw getError(res);

        // Call the parent
        Parent::close(graceful);
    }

protected:
    //-------------------------------------------------------------
    /// @details
    ///		This is an unused error code in minizip that signals
    ///		that we have set pending error
    //-------------------------------------------------------------
    _const int32_t MZ_ENGINE_FAILURE = -1024;

    //-------------------------------------------------------------
    /// @details
    ///		Pending error
    //-------------------------------------------------------------
    Error m_pendingError;

    //-------------------------------------------------------------
    /// @details
    ///		Mutex to guarantee we are writing only a single
    ///		substream at a time
    //-------------------------------------------------------------
    async::Mutex m_mutex{};

    //-------------------------------------------------------------
    /// @details
    ///		Zip file info used with minzip
    //-------------------------------------------------------------
    zipFile m_zipFile = nullptr;

    //-------------------------------------------------------------
    /// @details
    ///		When a failure happens on the minizip, if we are in
    ///		supporting the zipnet, there may be additional information
    ///		in the m_pendingError. If we are supporting zipfile,
    ///		the failures are just the regular old minizip error
    ///		codes
    ///	@param[in] minizipCode
    ///		The minizip code that was returned via the API
    //-------------------------------------------------------------
    Error getError(int32_t minizipCode) {
        // If one of our stream* functions returned this error, it
        // put the actual code into m_pendingError with the full
        // error info
        if (minizipCode == MZ_ENGINE_FAILURE) {
            if (!m_pendingError)
                return APERR(MZ_ENGINE_FAILURE, "Minizip engine failure");
            else
                return m_pendingError;
        }

        // If we have no error from minizip, return nothing
        if (!minizipCode) return {};

        // Build an appropriate error code
        return APERR(minizipCode, "Minizip failure");
    }
};
}  // namespace engine::stream::zipbase
