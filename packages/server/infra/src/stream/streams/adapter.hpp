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

namespace ap::memory::adapter {
// Specialize the io adapter to write out to a stream with
// ap libs toBinary/fromBinary hooks
template <>
class Output<engine::StreamPtr, AlwaysT> {
public:
    Output(engine::StreamPtr stream, Opt<file::Path> path = {}) noexcept
        : m_stream(_mv(stream)), m_path(_mv(path)) {}

    Size_t offset() const noexcept { return m_offset; }

    void setOffset(uint64_t offset) const noexcept(false) {
        APERR_THROW(Ec::NotSupported,
                    "Cannot reposition stream output adapter");
    }

    void write(InputData data) noexcept(false) {
        m_stream->write(data);
        m_offset += data.size();
    }

    uint64_t size() const noexcept(false) { return m_stream->size(); }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        return _tsb(buff, *m_stream);
    }

    file::Path path() const noexcept {
        if (m_path) return m_path.value();
        return m_stream->url().fullpath();
    }

private:
    engine::StreamPtr m_stream;
    Opt<file::Path> m_path;
    size_t m_offset{};
};

template <>
class Input<engine::StreamPtr, AlwaysT> {
public:
    Input(engine::StreamPtr stream, Opt<file::Path> path = {}) noexcept
        : m_stream(_mv(stream)), m_path(_mv(path)) {}

    Size_t offset() const noexcept { return m_offset; }

    uint64_t size() const noexcept(false) { return m_stream->size(); }

    void setOffset(uint64_t offset) const noexcept(false) {
        APERR_THROW(Ec::NotSupported, "Cannot reposition stream input adapter");
    }

    size_t read(OutputData data, Opt<size_t> min = {}) const noexcept(false) {
        const auto length = m_stream->read(data);
        if (length < min.value_or(length))
            APERR_THROW(Ec::Read, "Read", length, "required", min);

        m_offset += length;
        return length;
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        return _tsb(buff, *m_stream);
    }

    file::Path path() const noexcept {
        if (m_path) return m_path.value();
        return m_stream->url().fullpath();
    }

private:
    engine::StreamPtr m_stream;
    Opt<file::Path> m_path;
    mutable size_t m_offset{};
};

}  // namespace ap::memory::adapter

namespace engine::stream {
using InputStream = memory::adapter::Input<engine::StreamPtr, AlwaysT>;
using OutputStream = memory::adapter::Output<engine::StreamPtr, AlwaysT>;
}  // namespace engine::stream
