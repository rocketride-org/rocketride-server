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

// Utility base class for a stream that wraps/filters another stream
class DecoratedStream : public iStream {
public:
    using Parent = iStream;

    DecoratedStream(StreamPtr stream) noexcept : m_stream(_mv(stream)) {
        ASSERT(m_stream);
    }

    void close(bool graceful = true) noexcept(false) override {
        m_stream->close(graceful);
    }
    void write(InputData data) noexcept(false) override {
        return m_stream->write(data);
    }
    size_t read(OutputData data) noexcept(false) override {
        return m_stream->read(data);
    }

    void setOffset(uint64_t offset) noexcept(false) override {
        // If we're already at the requested offset, do nothing (avoids errors
        // from streams that don't support seeks)
        if (offset != this->offset()) m_stream->setOffset(offset);
    }

    size_t size() noexcept(false) override { return m_stream->size(); }
    uint64_t offset() noexcept override { return m_stream->offset(); }
    const file::Path path() const noexcept override { return m_stream->path(); }
    Mode mode() const noexcept override { return m_stream->mode(); }

    Size chunkSize() const noexcept override { return m_stream->chunkSize(); }
    Size maxIoSize() const noexcept override { return m_stream->maxIoSize(); }

    // Access decorated stream directly
    StreamPtr stream() const noexcept { return m_stream; }

protected:
    StreamPtr m_stream;
};

}  // namespace engine::stream
