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

namespace engine::stream {

BufferedStream::BufferedStream(StreamPtr io, Options opts) noexcept(false)
    : Parent(_mv(io)), m_ioThread(_location, _tsd<' '>("I/O", mode(), path())) {
    *m_buffs.init(opts);
    startIo();
}

void BufferedStream::close(bool graceful) noexcept(false) {
    auto guard = lockClient();

    // Gracefully flush first if in write mode
    // this makes all the used buffers get written out
    // (no more are coming)
    Error flushError;
    if (writeMode()) {
        if (!graceful)
            m_buffs.cancel(APERRT(Ec::Cancelled, "Ungraceful close"));
        else
            flushError = m_buffs.flush(graceful, true);
    }

    // Stop the io and close the io
    stopIo(_location);

    // Close the stream
    m_stream->close(graceful);

    // Finally, throw any error from m_buffs.flush()
    flushError.checkThrow();
}

void BufferedStream::write(InputData data) noexcept(false) {
    if (!writeMode())
        APERRT_THROW(Ec::InvalidCommand, "Not opened for write", path());

    auto guard = lockClient();

    while (data) {
        auto buff = *m_buffs.writerPop();
        m_offset += buff.cursor.copyConsume(data);
        *m_buffs.writerPush(_mv(buff));
    }
}

size_t BufferedStream::read(OutputData data) noexcept(false) {
    if (!readMode())
        APERRT_THROW(Ec::InvalidCommand, "Not opened for read", path());

    auto guard = lockClient();

    size_t sizeRead = 0;
    while (data) {
        auto buff = m_buffs.readerPop();
        if (!buff) {
            // If we got to the end, bail
            if (buff.ccode() == Ec::Completed) return sizeRead;

            // Otherwise, throw the error
            buff.rethrow();
        }

        auto len = data.copyConsume(buff->cursor);
        m_offset += len;
        sizeRead += len;

        *m_buffs.readerPush(_mv(*buff));
    }

    return sizeRead;
}

void BufferedStream::ioReader() const noexcept {
    // Consume buffers from the in queue and
    // write them to the io
    while (auto buff = m_buffs.writerPop()) {
        // Acquire the i/o lock to sync with potential re-positions
        auto guard = m_ioLock.acquire();

        // If we fail to read, chain error to the buffers
        auto readLen = m_stream->tryRead(buff->cursor);
        if (!readLen) m_buffs.cancel(readLen.ccode()).rethrow();

        if (*readLen == 0) {
            m_buffs.writerPush(_mv(*buff));
            m_buffs.complete();
            break;
        }

        // Consume what we read into it
        std::advance(buff->cursor, *readLen);

        // Force it on the used list here
        if (m_buffs.writerPush(_mv(*buff), true)) break;
    }
}

void BufferedStream::ioWriter() noexcept {
    // Consume buffers from the in queue and
    // write them to the io
    while (auto buff = m_buffs.readerPop()) {
        // Acquire the i/o lock to sync with potential re-positions
        auto guard = m_ioLock.acquire();

        // If we fail to write, chain error to the buffers
        if (auto ccode = m_stream->tryWrite(buff->cursor))
            m_buffs.cancel(ccode).rethrow();

        // Wrote the whole thing; invalidate the cursor
        buff->cursor = {};

        if (m_buffs.readerPush(_mv(*buff))) break;
    }
}

}  // namespace engine::stream
