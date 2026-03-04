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

namespace engine::stream::zipnet {
//-------------------------------------------------------------------------
///	@details
///		The trace flag for this component
//-------------------------------------------------------------------------
_const auto Level = Lvl::StreamZipnet;

//-------------------------------------------------------------------------
///	@details
///		The type of this stream
//-------------------------------------------------------------------------
_const auto Type = "zipnet"_itv;

//-------------------------------------------------------------------------
// Register the protocol config with the Url system. This
// allows call Url::toPath(...), Url::toUrl(...), etc
//-------------------------------------------------------------------------
static url::UrlConfig urlConfig{
    {//------------------------------------------------------------
     /// @details
     ///	Define the protocol capabilities
     //------------------------------------------------------------
     .capabilities =
         Url::PROTOCOL_CAPS::SUBSTREAM | Url::PROTOCOL_CAPS::NETWORK,

     //------------------------------------------------------------
     /// @details
     ///	Define the protocol type
     //------------------------------------------------------------
     .protocol = Type,

     //------------------------------------------------------------
     /// @details
     ///	Given a fully qualified path in the form of
     ///	zipnet://host:port/targetId, returns the entire url
     ///	so that we can pass it properly to ZipOpen
     /// @param[in]	fromUrl
     ///	Url to convert
     /// @param[out] toPath
     ///	Receives the path
     //------------------------------------------------------------
     .toPath = [](const Url &fromUrl, file::Path &toPath) -> Error {
         // Validate it
         if (auto ccode = urlConfig.validate(fromUrl)) return ccode;

         // Get the path
         auto path = fromUrl.fullpath();

         // Grab the target which is the 2nd component
         toPath = file::Path{path.at(1)};
         return {};
     },

     //------------------------------------------------------------
     /// @details
     ///		Validate that the given directory does not go
     ///		outside of our control/data/...
     ///	@param[in]
     ///		The file path part - must be just a filename
     //------------------------------------------------------------
     .validate = [](const Url &url) -> Error {
         ASSERT(url.protocol() == Type);

         // Get the path
         const auto path = url.fullpath();

         // Must have at exactly 2 components (comp 0=host:port, 1=target)
         if (path.count() != 2)
             return APERRX(
                 Level, Ec::InvalidParam,
                 "zipnet path has unexpected number of components:", path);

         return {};
     }}};

//-------------------------------------------------------------------------
/// @details
///		Define the actual stream interface for the zipnet driver. This
///		endpoint connects to the application and sends the zip file over
///		the network channel using the streaming mode of minizip-ng
///
/// 	The API into minizip-ng is absolutely hideous. It's actually well
///		designed and thought out for it's functionality, but everything
///		is a void * or a void **. There is little to no documentation
///		or examples of how to do streams, so all this was determined by
///		tracing through the source code.
///
//-------------------------------------------------------------------------
class ZipNet : public stream::zipbase::ZipBase<Level> {
public:
    using Parent = stream::zipbase::ZipBase<Level>;
    using Parent::Parent;
    using ConnPtr = SharedPtr<net::rpc::Connection>;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<ZipNet, iStream>(Type);

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    ZipNet(const FactoryArgs &args) noexcept {}
    virtual ~ZipNet() {}

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------

    //-----------------------------------------------------------------
    /// @details
    ///		Open the stream in the given mode. This is the main open
    ///		call which will open the zip file on disk
    ///	@param[in] url
    ///		The url to open
    ///	@param[in] mode
    ///		The mode to open in
    //-----------------------------------------------------------------
    Error open(const Url &url, stream::Mode mode) override {
        // Validate it
        if (auto ccode = Url::validate(url)) return ccode;

        // Save the url
        m_url = url;

        // Get the target
        m_target = url.lookup<Text>("target", "platform"_tv);

        // Get the path
        Text path = (TextView)url;

        // Create the zip file
        m_zipFile = zipOpen2_64((void *)path.c_str(), APPEND_STATUS_CREATE,
                                NULL, &m_vtbl);
        if (!m_zipFile) return getError(MZ_ENGINE_FAILURE);

        // Go ahead
        return {};
    }

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Makes a connection with the remote host
    /// @param[in]	url
    ///		Url to connect to
    ///
    /// Note: For PipeNet, the url is:
    ///		PipeNet://host:port/token?{std datanet params}
    //-----------------------------------------------------------------
    static ErrorOr<ConnPtr> makeConnection(const Url &url) {
        net::TlsConnection::Options tlsOptions;

        // Get the secure flag to determine if we are running secure or not
        bool isSecure = url.lookup<bool>("secure");

        // If we are secure, then pull the tls options from the url query params
        if (isSecure) {
            // Grab the tls options
            tlsOptions = _fjc<net::TlsConnection::Options>(url.queryParams());
        }

        // Allocate the connection
        auto conn = makeShared<net::rpc::Connection>();
        if (!conn)
            return APERR(Ec::InvalidRpc, "Unable to create a connection");

        // Now, connect it
        if (auto ccode =
                conn->connect(url.host(), url.port(), isSecure, tlsOptions)) {
            return ccode;
        }

        return conn;
    }

    //---------------------------------------------------------------------
    /// @details
    ///		Casts the minizip opaque ptr to our self ptr
    ///	@param[in] pSelf
    ///		Our this ptr
    //---------------------------------------------------------------------
    static ZipNet *getSelf(void *pSelf) {
        // Get our context
        return (ZipNet *)pSelf;
    }

    //---------------------------------------------------------------------
    /// @details
    ///		Sets an error in our pending error and returns a reserved
    ///		numeric integer that we can pick up
    ///	@param[in] pSelf
    ///		Our this ptr
    ///	@param[in] ccode
    ///		Our error code
    //---------------------------------------------------------------------
    static int32_t streamSetIntError(void *pSelf, Error ccode) {
        // Update our this ptr
        auto self = getSelf(pSelf);

        // Save the error and return an error code
        self->m_pendingError = ccode;

        // Return a non-minizip-ng error code - any error code will do
        return MZ_ENGINE_FAILURE;
    }

    //---------------------------------------------------------------------
    /// @details
    ///		Sets an error in our pending error and returns a reserved
    ///		numeric integer that we can pick up
    ///	@param[in] pSelf
    ///		Our this ptr
    ///	@param[in] ccode
    ///		Our error code
    //---------------------------------------------------------------------
    static void *streamSetVoidPtrError(void *pSelf, Error ccode) {
        // Update our this ptr
        auto self = getSelf(pSelf);

        // Save the error and return an error code
        self->m_pendingError = ccode;

        // Return a nullptr
        return nullptr;
    }

    //---------------------------------------------------------------------
    /// @details
    ///		Returns a pending error
    ///	@param[in]	pSelf
    ///		Our context allocated via create
    ///	@param[in]	pStream
    ///		The data we return from streamOpen (also a this ptr)
    //---------------------------------------------------------------------
    static int streamError(void *pSelf, void *pStream) {
        // Update our this ptr
        auto self = getSelf(pSelf);

        // If we have a pending error, return general engine failure
        if (self->m_pendingError)
            return MZ_ENGINE_FAILURE;
        else
            return MZ_OK;
    }

    //---------------------------------------------------------------------
    /// @details
    ///		Open the stream on the app. The path is our full URL
    ///	@param[in]	pSelf
    ///		Our this ptr
    ///	@param[in]	pFilename
    ///		The path - not really used - we use our m_url
    ///	@param[in]	mode
    ///		Will always be write mode
    //---------------------------------------------------------------------
    static void *streamOpen(void *pSelf, const void *pFilename, int32_t mode) {
        // Update our this ptr
        auto self = getSelf(pSelf);

        if (mode != MZ_OPEN_MODE_WRITE && mode != MZ_OPEN_MODE_CREATE)
            return streamSetVoidPtrError(
                self, APERR(Ec::InvalidParam, "Invalid zip open mode"));

        // Create the connection
        ErrorOr<ConnPtr> conn = makeConnection(self->m_url);
        if (!conn) return streamSetVoidPtrError(self, conn.ccode());

        // Grab the connection
        self->m_conn = _mv(*conn);

        // Get the target handle to write to
        file::Path path;
        if (auto ccode = Url::toPath(self->m_url, path))
            return streamSetVoidPtrError(pSelf, ccode);

        // url.path is the path of the subitem
        auto res = self->m_conn->submitOn<net::rpc::v3::stream::Open>(
            self->m_target, (TextView)path);

        // Verify a stream handle was returned (will be 0 in the error case)
        if (!res->data.streamHandle) {
            // Release the connection handle
            self->m_conn.reset();

            // Return an error
            return streamSetVoidPtrError(
                pSelf, APERR(Ec::InvalidRpc, "Could not open zipnet", path));
        }

        // Save the handle
        self->m_streamHandle = res->data.streamHandle;

        // It is now open
        return pSelf;
    }

    //---------------------------------------------------------------------
    /// @details
    ///		Writes the data to the target
    ///	@param[in]	pSelf
    ///		Our this ptr
    ///	@param[in]	pStream
    ///		The data we return from streamOpen (also a this ptr)
    ///	@param[in]	buf
    ///		Buffer to write
    ///	@param[in]	size
    ///		Size to write
    //---------------------------------------------------------------------
    static unsigned long streamWrite(void *pSelf, void *pStream,
                                     const void *buf, unsigned long size) {
        // Update our this ptr
        auto self = getSelf(pSelf);

        // Build a data input descriptor
        InputData data{buf, (size_t)size};

        // Write it
        auto res = self->m_conn->submitDataOn<net::rpc::v3::stream::Write>(
            self->m_target, data, self->m_streamHandle);

        // If we just flat our failed, set the error
        if (!res) {
            streamSetIntError(pSelf, res.ccode());
            return 0;
        }

        // Ok
        return size;
    }

    //---------------------------------------------------------------------
    /// @details
    ///		Close the stream on the app
    ///	@param[in]	pSelf
    ///		Our this ptr
    ///	@param[in]	pStream
    ///		The data we return from streamOpen (also a this ptr)
    //---------------------------------------------------------------------
    static int32_t streamClose(void *pSelf, void *pStream) {
        // Update our this ptr
        auto self = getSelf(pSelf);

        self->m_conn->submitOn<net::rpc::v3::stream::Close>(
            self->m_target, self->m_streamHandle);
        self->m_streamHandle = {};
        return MZ_OK;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Shared connection ptr that we write the zip it
    //-------------------------------------------------------------
    SharedPtr<net::rpc::Connection> m_conn{};

    //-------------------------------------------------------------
    /// @details
    ///		Stream handle that we opened on the server
    //-------------------------------------------------------------
    Text m_streamHandle{};

    //-------------------------------------------------------------
    /// @details
    ///		The url we need to connect to
    //-------------------------------------------------------------
    Url m_url;

    //-------------------------------------------------------------
    /// @details
    ///		This is the target we are going to send to. This is
    ///		the ?target= param, which is usually pointing to the
    ///		platform
    //-------------------------------------------------------------
    Text m_target = "platform";

    //-------------------------------------------------------------
    /// @details
    ///		Our interface table we pass to minizip-ng
    //-------------------------------------------------------------
    zlib_filefunc64_def m_vtbl = {.zopen64_file = streamOpen,
                                  .zread_file = nullptr,
                                  .zwrite_file = streamWrite,
                                  .ztell64_file = nullptr,
                                  .zseek64_file = nullptr,
                                  .zclose_file = streamClose,
                                  .zerror_file = streamError,
                                  .opaque = this};
};
}  // namespace engine::stream::zipnet
