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

#pragma once

namespace engine::stream::datanet {
//-------------------------------------------------------------------------
///	@details
///		The trace flag for this component
//-------------------------------------------------------------------------
_const auto Level = Lvl::StreamDatanet;

//-------------------------------------------------------------------------
///	@details
///		The type of this stream
//-------------------------------------------------------------------------
_const auto Type = "datanet"_itv;

//-------------------------------------------------------------------------
// Register the protocol config with the Url system. This
// allows call Url::toPath(...), Url::toUrl(...), etc
//-------------------------------------------------------------------------
static url::UrlConfig urlConfig{
    {//------------------------------------------------------------
     /// @details
     ///	Define the protocol capabilities
     //------------------------------------------------------------
     .capabilities = Url::PROTOCOL_CAPS::NETWORK | Url::PROTOCOL_CAPS::DATANET,

     //------------------------------------------------------------
     /// @details
     ///	Define the protocol type
     //------------------------------------------------------------
     .protocol = Type,

     //------------------------------------------------------------
     /// @details
     ///	    Given a fully qualified url in the form of
     ///	    datanet://<host>/dir/file.dat, returns the
     ///	    path ("<host>", "dir", "file.dat")
     /// @param[in]	fromUrl
     ///	    Url to convert
     /// @param[out] toPath
     ///	    Receives the path
     //------------------------------------------------------------
     .toPath = [](const Url& fromUrl, file::Path& toPath) -> Error {
         // Validate it
         if (auto ccode = urlConfig.validate(fromUrl)) return ccode;

         // Get the path
         auto path = fromUrl.fullpath();

         // Grab what we need and convert to a path
         toPath =
             file::Path{config::paths().lookup(path.at(1)) / path.fileName()};

         return {};
     },

     //------------------------------------------------------------
     /// @details
     ///	    verifies that the given url is valid and in the form
     ///	    of datanet://<host>/dir/file
     /// @param[in]	url
     ///	    Url to convert
     //------------------------------------------------------------
     .validate = [](const Url& url) -> Error {
         // Get the path
         const auto path = url.fullpath();

         // Must have at exactly 3 components
         if (path.count() != 3)
             return APERRX(
                 Level, Ec::InvalidParam,
                 "datanet path has unexpected number of components:", path);

         return {};
     }}};

//-------------------------------------------------------------------------
/// @details
///		Define the actual stream interface for the datanet:// endpoint.
///		This returned on open
//-------------------------------------------------------------------------
class DataNet : public iStream {
public:
    using Parent = iStream;
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
    _const auto Factory = Factory::makeFactory<DataNet, iStream>(Type);

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    DataNet(const FactoryArgs& args) noexcept {}
    virtual ~DataNet() {}

    //---------------------------------------------------------------------
    // Public API
    //---------------------------------------------------------------------
    Error open(const Url& url, stream::Mode mode) override {
        // Calculate the mode string expected by the app
        const auto remoteMode =
            (stream::isWriteMode(mode) && stream::isCreateMode(mode)) ? "w+"
                                                                      : "r";

        // Create the connection
        ErrorOr<ConnPtr> conn = makeConnection(url);
        if (!conn) return conn.ccode();

        m_conn = _mv(*conn);

        // Open it
        LOGT("Opening path: {} mode: ", url, remoteMode);
        auto file = m_conn->submit<net::rpc::v3::file::Open>(
            url.pathComp(1), url.pathComp(2), remoteMode);

        // Verify a file handle was returned (will be 0 in the error case)
        if (!file->data.hFile)
            APERRT_THROW(Ec::InvalidRpc, "Could not open", path());

        LOGT("Successfully opened", path());
        m_hStream = _mv(file->data.hFile);
        return Parent::open(url, mode);
    }

    void close(bool graceful) noexcept(false) override {
        if (!m_hStream) return;

        LOGT("{} close", m_hStream);
        *m_conn->submit<net::rpc::v3::file::Close>(m_hStream);
        m_hStream = {};
        Parent::close(graceful);
    }

    void write(InputData data) noexcept(false) override {
        if (!data.size()) return;

        auto res = _mv(*m_conn->submitData<net::rpc::v3::file::Write>(
            data, m_hStream, data.size(), m_offset));

        if (res->data.length != data.size())
            APERRT_THROW(Ec::InvalidRpc, "Short write", data.size(),
                         res->data.length);

        m_offset += data.size();

        LOGT("{} write {,X} {}", m_hStream, m_offset, Size(data.size()));
    }

    size_t read(OutputData data) noexcept(false) override {
        if (!data.size()) return 0;

        size_t sizeToRead = data.size();  // amount of bytes we`re about to read
        size_t sizeRead = 0;  // total number of bytes we actually read
        size_t resSize = 0;   // current response data size
        size_t offsetInBuffer =
            0;  // offset in buffer where to put data from current response

        /*
        * The application is limiting read chunks to 256K. If the engine issues
        a read for more the 256K, it will be truncated to 256K. The length
        actually read will be returned in the status length. That`s why we have
        to read chunks in the loop to get all the requested amount of data.

        The idea here was to prevent some application (engine or another node
        process) from reading a huge amount of data which would kill the event
        loop in the app and make performance extremely sluggish.

        For more details see https://rocketride.atlassian.net/browse/APPLAT-3664
        */
        while (sizeToRead > 0) {
            auto res = _mv(*m_conn->submit<net::rpc::v3::file::Read>(
                m_hStream, sizeToRead, m_offset));

            resSize = res.data().size();

            if (resSize == 0)  // nothing more to read
                break;

            if (res->data.length != resSize)
                APERRT_THROW(Ec::InvalidRpc,
                             "Data returned does not match the length", resSize,
                             res->data.length);

            if (resSize > sizeToRead)
                APERRT_THROW(Ec::InvalidRpc,
                             "Data read size is bigger than requested", resSize,
                             sizeToRead);

            // append data from request at needed offset
            data.copyAt(offsetInBuffer, res.data());

            // adjust offset in output data buffer
            offsetInBuffer += resSize;

            // adjust offset in current stream
            m_offset += resSize;

            // adjust how many bytes did we read and how many more bytes left to
            // read
            sizeToRead -= resSize;
            sizeRead += resSize;
        }

        LOGT("{} read {,X} {}", m_hStream, m_offset, Size(sizeRead));
        return sizeRead;
    }

    void setOffset(uint64_t offset) noexcept(false) override {
        m_offset = offset;
    }

    size_t size() noexcept(false) override {
        auto res = _mv(*m_conn->submit<net::rpc::v3::file::Length>(m_hStream));
        const auto length = res->data.size;
        LOGT("{} size {}", m_hStream, Size(length));
        return (size_t)length;
    }

    uint64_t offset() noexcept override { return m_offset; }

private:
    ErrorOr<ConnPtr> makeConnection(const Url& url) const noexcept(false) {
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

    SharedPtr<net::rpc::Connection> m_conn;
    Text m_hStream;
    uint64_t m_offset = 0;
};
}  // namespace engine::stream::datanet
