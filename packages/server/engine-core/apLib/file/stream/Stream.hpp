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

namespace ap::file::stream {

// A file stream takes some generic stream type and wraps it in a
// standard byte based stream interface
template <typename StreamT>
class Stream final {
public:
    using StreamType = StreamT;
    using MappedCtx = typename StreamType::MappedCtx;
    _const auto MaxIOSize = StreamType::MaxIOSize;

    _const auto LogLevel = Lvl::FileStream;

    // Default constructor
    Stream() = default;

    // Move
    Stream(Stream &&stream) { move(_mv(stream)); }

    Stream &operator=(Stream &&stream) noexcept { return move(_mv(stream)); }

    // No copy
    Stream(const Stream &stream) = delete;
    Stream &operator=(const Stream &stream) = delete;

    // Throw based constructor that opens
    template <typename ChrT, typename AllocT>
    Stream(FilePath<ChrT, AllocT> path, Mode mode) noexcept(false) {
        *open(_mv(path), mode);
    }

    ~Stream() noexcept { close(); }

    template <typename ChrT, typename AllocT>
    Error open(FilePath<ChrT, AllocT> path, Mode mode) noexcept {
        if (m_mode != Mode::NONE)
            return APERRT(Ec::InvalidState, "File already open", path);

        if (isCreateMode(mode) && !file::exists(path.parent())) {
            if (auto ccode = file::mkdir(path.parent())) return ccode;
        }

        if (auto ccode = m_stream.open(path.plat(), mode)) return ccode;

        m_mode = mode;
        m_path = _mv(path);
        return {};
    }

    ErrorOr<size_t> seek(uint64_t offset, int whence) const noexcept {
        if (auto pos = m_stream.seek(offset, whence); pos.check())
            return pos;
        else {
            m_offset = _mv(*pos);
            return _cast<size_t>(m_offset);
        }
    }

    // Self allocated result apis
    template <typename AllocT = std::allocator<uint8_t>>
    ErrorOr<memory::Data<uint8_t, AllocT>> read(
        size_t length, Opt<uint64_t> offset = {},
        const AllocT &allocator = {}) const noexcept {
        m_offset = offset.value_or(m_offset);
        memory::Data<uint8_t, AllocT> data(length, allocator);
        auto lengthRead = chunkedRead(data);
        if (!lengthRead) return lengthRead.ccode();
        data.resize(*lengthRead);
        m_offset += *lengthRead;
        return data;
    }

    // View based apis
    [[nodiscard]] ErrorOr<size_t> read(
        OutputData data, Opt<uint64_t> offset = {}) const noexcept {
        m_offset = offset.value_or(m_offset);

        auto lengthRead = chunkedRead(data);
        if (!lengthRead.check()) m_offset += *lengthRead;
        return lengthRead;
    }

    Error write(InputData data, Opt<uint64_t> offset = {}) noexcept {
        m_offset = offset.value_or(m_offset);
        if (auto ccode = chunkedWrite(data)) return ccode;
        m_offset += data.size();
        return {};
    }

    Error flush() noexcept { return m_stream.flush(); }

    Error truncate(uint64_t offset) noexcept {
        unmap();
        return m_stream.truncate(offset);
    }

    Error close(bool flush = false) noexcept {
        unmap();
        m_offset = {};
        m_mode = Mode::NONE;
        return m_stream.close(flush);
    }

    uint64_t offset() const noexcept { return m_offset; }
    void setOffset(uint64_t offset) const noexcept { m_offset = offset; }
    const file::Path &path() const noexcept { return m_path; }
    ErrorOr<uint64_t> size() const noexcept { return m_stream.size(); }
    auto platHandle() const noexcept { return m_stream.handle(); }

    Mode mode() const noexcept { return m_mode; }
    bool createMode() const noexcept { return isCreateMode(m_mode); }
    bool writeMode() const noexcept { return isWriteMode(m_mode); }
    bool readMode() const noexcept { return isReadMode(m_mode); }
    bool openMode() const noexcept { return !isClosedMode(m_mode); }

    explicit operator bool() const noexcept { return openMode(); }

    ErrorOr<StatInfo> stat() const noexcept {
        if (isClosedMode(m_mode))
            return APERRT(Ec::InvalidParam, "Cannot init mapping not opened");
        auto platStat = m_stream.stat();
        if (!platStat) return platStat.ccode();
        return _tr<StatInfo>(*platStat, m_path);
    }

    Error mapInit(uint64_t size) noexcept {
        if (isClosedMode(m_mode))
            return APERRT(Ec::InvalidParam, "Cannot init mapping not opened");
        return m_stream.mapInit(m_mode, size);
    }

    ErrorOr<InputData> mapInputRange(Opt<uint64_t> offset = {},
                                     Opt<uint64_t> size = {}) noexcept {
        if (isClosedMode(m_mode))
            return APERRT(Ec::InvalidParam,
                          "Cannot create input range on an un-opened file");
        auto ctx = mapRange(offset, size);
        if (!ctx) return ctx.ccode();
        return InputData{_reCast<const uint8_t *>(ctx->get().data),
                         ctx->get().size};
    }

    ErrorOr<OutputData> mapOutputRange(Opt<uint64_t> offset = {},
                                       Opt<uint64_t> size = {}) noexcept {
        if (!isWriteMode(m_mode))
            return APERRT(
                Ec::InvalidParam,
                "Attempt to map output range when file is opened for read");
        auto ctx = mapRange(offset, size);
        if (!ctx) return ctx.ccode();
        return OutputData{_reCast<uint8_t *>(ctx->get().data), ctx->get().size};
    }

    template <Mode ModeT>
    auto mapRangeMode(Opt<uint64_t> offset = {},
                      Opt<uint64_t> size = {}) noexcept {
        if constexpr (isWriteMode(ModeT))
            return mapOutputRange(offset, size);
        else
            return mapInputRange(offset, size);
    }

    ErrorOr<InputData> mmap() noexcept { return mapInputRange(); }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "FileStream";
    }

private:
    Error chunkedWrite(InputData data) noexcept {
        auto offset = m_offset;
        while (data) {
            auto chunk = data.consumeSlice(MaxIOSize);
            if (auto ccode = m_stream.writeAt(offset, chunk)) return ccode;
            offset += chunk.size();
            m_writtenSize += chunk.size();
            if (m_writtenSize >= m_bufferSize) {
                if (auto ccode = flush()) return ccode;
                m_writtenSize = 0;
            }
        }
        return {};
    }

    ErrorOr<size_t> chunkedRead(OutputData data) const noexcept {
        auto offset = m_offset;
        size_t total = 0;
        size_t pos = 0;
        while (data) {
            auto chunk = data.sliceAt(pos, MaxIOSize);
            auto length = m_stream.readAt(offset, chunk);
            if (length.check()) return length.ccode();
            data += *length;
            total += *length;
            offset += *length;
            if (!*length) break;
        }

        return total;
    }

    ErrorOr<uint64_t> sizeAt(uint64_t offset) const noexcept {
        auto len = size();
        if (!len) return len.ccode();
        if (offset > *len) return 0ul;
        return *len - offset;
    }

    ErrorOr<Ref<MappedCtx>> mapRange(Opt<uint64_t> offset = {},
                                     Opt<uint64_t> size = {}) noexcept {
        // Normalize their requests
        auto requestedOffset = offset.value_or(m_offset);
        auto availableSize = sizeAt(requestedOffset);

        if (!availableSize) return availableSize.ccode();

        auto requestedSize = size.value_or(*availableSize);

        // If we're in read mode, our current file size is not negotiable
        if (isReadMode(m_mode)) {
            if (*availableSize < requestedSize)
                return APERRT(Ec::InvalidParam,
                              "Cannot create file mapping of size",
                              requestedSize, "only", availableSize,
                              "available at offset", requestedOffset);
        }

        // Ok this should work, make a map
        auto ctx = m_stream.map(m_mode, requestedOffset, requestedSize);
        if (!ctx) return ctx.ccode();

        return makeRef(m_mappings.emplace_back(_mv(*ctx)));
    }

    void unmap() noexcept {
        for (auto &m : m_mappings) m_stream.unmap(m);
        m_mappings.clear();
        m_stream.unmap();
    }

    Stream &move(Stream &&strm) noexcept {
        if (this == &strm) return *this;

        close();
        m_stream = _mv(strm.m_stream);
        m_offset = _exch(strm.m_offset, 0);
        m_mode = _exch(strm.m_mode, Mode::NONE);
        m_mappings = _mv(strm.m_mappings);
        return *this;
    }

private:
    StreamType m_stream;
    mutable uint64_t m_offset = 0;
    mutable size_t m_writtenSize = 0;
    _const size_t m_bufferSize = 1_gb;
    Mode m_mode = Mode::NONE;
    std::vector<MappedCtx> m_mappings;
    file::Path m_path;
};

}  // namespace ap::file::stream
