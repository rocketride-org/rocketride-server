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

namespace engine::stream {
// A buffered stream wraps a stream and adds a layer of
// buffering on top of it
class BufferedStream final : public DecoratedStream {
public:
    _const auto LogLevel = Lvl::Buffer;

    using Parent = DecoratedStream;
    using Buffers = async::Buffers<uint8_t>;
    using Options = async::BufferOptions;

    BufferedStream(StreamPtr io, Options opts) noexcept(false);

    ~BufferedStream() noexcept { stopIo(_location); }

    void close(bool graceful) noexcept(false) override;
    void write(InputData data) noexcept(false) override;
    size_t read(OutputData data) noexcept(false) override;

    uint64_t offset() noexcept override {
        auto guard = lockClient();
        return m_offset;
    }

    void setOffset(uint64_t offset) noexcept(false) override {
        if (!readMode())
            APERRT_THROW(Ec::Bug, "Set offset only supported on read", path());

        auto guard = lockClient();

        stopIo(_location);

        // And reposition the i/o
        m_stream->setOffset(offset);

        // And re-start the io reader
        startIo();
    }

    // Advanced api, use with caution
    ErrorOr<Buffers::Buffer> get() noexcept {
        auto guard = lockClient();
        if (readMode()) return m_buffs.readerPop();
        return m_buffs.writerPop();
    }

    Error put(Buffers::Buffer &&buff) noexcept {
        auto guard = lockClient();

        Error ccode;
        auto size = buff.size();
        if (readMode())
            ccode = m_buffs.readerPush(_mv(buff), true);
        else
            ccode = m_buffs.writerPush(_mv(buff), true);

        if (!ccode) m_offset += size;
        return ccode;
    }

    Size maxIoSize() const noexcept override {
        return m_buffs.options().maxIoSize;
    }

private:
    void ioReader() const noexcept;
    void ioWriter() noexcept;

    async::MutexLock::Guard lockClient() const noexcept {
        return m_clientLock.acquire();
    }

    void stopIo(Location location) const noexcept {
        m_buffs.cancel(location);
        m_ioThread.stop();
        m_buffs.reset();
        m_offset = 0;
    }

    void startIo() const noexcept(false) {
        m_offset = m_stream->offset();

        ASSERT(!m_buffs.cancelled() && !m_buffs.completed());
        if (readMode())
            *m_ioThread.start(_bind(&BufferedStream::ioReader, this));
        else if (writeMode())
            *m_ioThread.start(_bind(&BufferedStream::ioWriter,
                                    _constCast<BufferedStream *>(this)));
        else
            APERRT_THROW(Ec::InvalidParam, "Not opened for i/o", path(),
                         mode());
    }

    // Our buffers
    mutable Buffers m_buffs;

    // Like the i/o lock the client lock logically locks this stream
    // from client side apis
    mutable async::MutexLock m_clientLock;

    // The io lock is a separate lock we use to synchronize with
    // the i/o thread, when held it means you have exclusive use
    // of the m_stream object
    mutable async::MutexLock m_ioLock;

    // Dedicated thread for this io reader or writer
    mutable async::Thread m_ioThread;

    // Our own buffered position
    mutable uint64_t m_offset = {};
};

}  // namespace engine::stream
