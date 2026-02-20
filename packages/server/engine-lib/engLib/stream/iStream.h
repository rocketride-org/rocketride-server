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

namespace engine::stream {
//-----------------------------------------------------------------
// The iStream interface is main interface to a single stream
//-----------------------------------------------------------------
class iStream {
public:
    //-----------------------------------------------------------------
    ///	@details
    ///		The factory class type
    //-----------------------------------------------------------------
    _const auto FactoryType = "iStream";

    //-----------------------------------------------------------------
    ///	@details
    ///		Define the arguments for creating the object
    //-----------------------------------------------------------------
    struct FactoryArgs {
        const Url url;
    };

    //-----------------------------------------------------------------
    ///	@details
    ///		Define the factory
    //-----------------------------------------------------------------
    static ErrorOr<Ptr<iStream>> __factory(Location location,
                                           uint32_t requiredFlags,
                                           const FactoryArgs &args) noexcept {
        return Factory::find<iStream>(location, requiredFlags,
                                      args.url.protocol(), args);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Define the destructor
    //-----------------------------------------------------------------
    virtual ~iStream() = default;

    //-----------------------------------------------------------------
    ///	@details
    ///		Validate the url is valid for the given endpoint
    /// @param[in]	url
    ///		Url to validate - must be of the same protocol as the
    ///		endpoint it is call one
    //-----------------------------------------------------------------
    virtual Error validateUrl(const Url &url) noexcept { return {}; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Open the stream
    /// @param[in]	url
    ///		Url to open
    ///	@param[in]	mode
    ///		The read or write mode to open the stream in
    //-----------------------------------------------------------------
    virtual Error open(const Url &url, stream::Mode mode) noexcept(false) {
        m_url = Url(url);
        m_mode = mode;
        return {};
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Write data to the stream
    /// @param[in]	data
    ///		data to write
    //-----------------------------------------------------------------
    virtual void write(InputData data) noexcept(false) {
        throw APERR(Ec::InvalidCommand, "Stream write not supported");
    };

    //-----------------------------------------------------------------
    ///	@details
    ///		Read data from the stream
    /// @param[out]	data
    ///		Buffer and length to read
    //-----------------------------------------------------------------
    virtual size_t read(OutputData data) noexcept(false) {
        throw APERR(Ec::InvalidCommand, "Stream read not supported");
    };

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the offset to read/write to/from
    /// @param[in]	offset
    ///		The new offset
    //-----------------------------------------------------------------
    virtual void setOffset(uint64_t offset) noexcept(false) {
        throw APERR(Ec::InvalidCommand, "Stream setOffset not supported");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Returns the size of the stream
    //-----------------------------------------------------------------
    virtual size_t size() noexcept(false) {
        throw APERR(Ec::InvalidCommand, "Stream size not supported");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Returns the curret offset of the stream
    //-----------------------------------------------------------------
    virtual uint64_t offset() noexcept(false) {
        throw APERR(Ec::InvalidCommand, "Stream offset not supported");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Opens a substream of the stream
    ///	@param[in]	entry
    ///		Contains the dates/times/etc for the stream to open
    ///	@param[in]	targetUrl
    ///		Target url - this is the url that the substream is
    ///		actually going to be named in the sub stream
    ///	@param[out]	ppContext
    ///		Recieves a ptr to some kind of context
    //-----------------------------------------------------------------
    virtual Error openSubStream(const Entry &entry, const Url &targetUrl,
                                void *&pContext) noexcept {
        return APERR(Ec::InvalidCommand, "Substreams not supported");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Write data to the substream
    ///	@param[in]	pContext
    ///		The stream handle returned from openSubStream
    ///	@param[in]	data
    ///		The data to write
    //-----------------------------------------------------------------
    virtual void writeSubStream(void *&pContext,
                                InputData data) noexcept(false) {
        throw APERR(Ec::InvalidCommand, "Substreams not supported");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Close the given substream
    ///	@param[in]	pContext
    ///		The stream handle returned from openSubStream
    //-----------------------------------------------------------------
    virtual void closeSubStream(void *&pContext,
                                bool graceful) noexcept(false) {
        throw APERR(Ec::InvalidCommand, "Substreams not supported");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Close the stream
    ///	@param[in]	graceful
    ///		Close the stream gracefully or just terminate it
    //-----------------------------------------------------------------
    virtual void close(bool graceful = true) noexcept(false) {
        m_mode = stream::Mode::NONE;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Return the open mode of the stream
    //-----------------------------------------------------------------
    virtual Mode mode() const noexcept { return m_mode; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Return the url of the stream
    //-----------------------------------------------------------------
    virtual const Url &url() const noexcept { return m_url; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Return the path for the url
    //-----------------------------------------------------------------
    virtual const file::Path path() const noexcept { return m_url.fullpath(); }

    //-----------------------------------------------------------------
    ///	@details
    ///		Perform seek+write
    /// @param[in]	offset
    ///		The new offset
    ///	@param[in]	data
    ///		The data to write
    //-----------------------------------------------------------------
    virtual void writeAtOffset(uint64_t offset,
                               InputData data) noexcept(false) {
        setOffset(offset);
        write(data);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Write data to pad to the given page size
    /// @param[in]	alignment
    ///		Will write nulls until offset is at this alignment
    //-----------------------------------------------------------------
    void writeAlign(Size alignment = plat::pageSize()) noexcept(false) {
        auto offsetTo = alignUp(offset(), alignment);
        Buffer pad(offsetTo - offset());
        write(pad);
    }

    //-----------------------------------------------------------------
    ///	@details
    /// 	Perform seek+read
    /// @param[in]	offset
    ///		The new offset
    ///	@param[in]	data
    ///		The data to read
    //-----------------------------------------------------------------
    virtual size_t readAtOffset(uint64_t offset,
                                OutputData data) noexcept(false) {
        setOffset(offset);
        return read(data);
    }

    //-----------------------------------------------------------------
    ///	@details
    /// 	Return the chunk size of the stream
    //-----------------------------------------------------------------
    virtual Size chunkSize() const noexcept { return 1_mb; }

    //-----------------------------------------------------------------
    ///	@details
    /// 	Return the maximum io size a stream can handle in a single
    ///		read/write operation
    //-----------------------------------------------------------------
    virtual Size maxIoSize() const noexcept { return 5_mb; }

    //-----------------------------------------------------------------
    ///	@details
    /// 	Boolean flags
    //-----------------------------------------------------------------
    bool createMode() const noexcept { return isCreateMode(mode()); }
    bool readMode() const noexcept { return isReadMode(mode()); }
    bool writeMode() const noexcept { return isWriteMode(mode()); }
    bool closed() const noexcept { return isClosedMode(mode()); }
    bool opened() const noexcept { return !isClosedMode(mode()); }

    //-----------------------------------------------------------------
    ///	@details
    /// 	Non-throwing wrappers for legacy API's
    //-----------------------------------------------------------------
    Error tryClose(bool graceful = true) noexcept {
        return _callChk([&] { close(graceful); });
    }
    Error tryCloseSubStream(void *pContext, bool graceful = true) noexcept {
        return _callChk([&] { closeSubStream(pContext, graceful); });
    }
    Error tryWrite(InputData data) noexcept {
        return _callChk([&] { write(data); });
    }
    Error tryWriteSubStream(void *pContext, InputData data) noexcept {
        return _callChk([&] { writeSubStream(pContext, data); });
    }
    Error tryWriteAtOffset(uint64_t offset, InputData data) noexcept {
        return _callChk([&] { writeAtOffset(offset, data); });
    }
    Error tryWriteAlign(Size alignment = plat::pageSize()) noexcept {
        return _callChk([&] { writeAlign(alignment); });
    }
    ErrorOr<size_t> tryRead(OutputData data) noexcept {
        return _call([&] { return read(data); });
    }
    ErrorOr<size_t> tryReadAtOffset(uint64_t offset, OutputData data) noexcept {
        return _call([&] { return readAtOffset(offset, data); });
    }
    Error trySetOffset(uint64_t offset) noexcept {
        return _callChk([&] { setOffset(offset); });
    }
    ErrorOr<size_t> tryGetSize() noexcept {
        return _call([&] { return size(); });
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        /// _tsbo(buff, Format::LOGGING, path(), " (", Size(offset()), ")");
    }

protected:
    //-----------------------------------------------------------------
    ///	@details
    /// 	Saves the url of the opened stream
    //-----------------------------------------------------------------
    Url m_url;
    //-----------------------------------------------------------------

    ///	@details
    /// 	Saves the mode the stream is opened with
    //-----------------------------------------------------------------
    stream::Mode m_mode = stream::Mode::NONE;
};
}  // namespace engine::stream
