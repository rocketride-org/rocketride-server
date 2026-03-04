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
#include <sys/mman.h>
#include <sys/file.h>

namespace ap::file::stream {

class File {
public:
    // This structure holds the information of a mapped region
    // in a file, a mapped region is a sub section of a mapped
    // file which can be locked in read or open for write
    // at a given offset with a given length
    struct MappedCtx {
        Mode mode = Mode::NONE;
        void* data = nullptr;
        uint64_t position = {};
        uint64_t size = {};
    };

    _const auto LogLevel = Lvl::FileStream;
    _const auto MaxIOSize = 500_mb;

    File() = default;

    template <typename ChrT, typename TraitsT, typename AllocT>
    File(const string::Str<ChrT, TraitsT, AllocT>& path,
         Mode mode) noexcept(false) {
        *open(path, mode);
    }

    ~File() noexcept { close(); }

    File(const File&) = delete;

    File(File&& file) noexcept { move(_mv(file)); }

    File& operator=(const File&) = delete;

    File& operator=(File&& file) noexcept { return move(_mv(file)); }

    Error close(bool flush = false) noexcept {
        if (flush && m_hFile != -1) {
            if (auto ccode = this->flush()) return ccode;
        }

        unmap();
        if (auto locked = _exch(m_locked, false); locked)
            ::flock(m_hFile, LOCK_UN | LOCK_NB);

        if (auto h = _exch(m_hFile, -1); h != -1) {
            if (::close(h))
                return APERRT(errno, "Received error while closing file");
        }

        return {};
    }

    Error flush() noexcept {
#if ROCKETRIDE_PLAT_MAC
        // fdatasync is not supported on OSX
        if (fsync(m_hFile)) return APERRT(errno, "Failed to flush data");
#else
        // For performance, flush data but not metadata
        if (fdatasync(m_hFile)) return APERRT(errno, "Failed to flush data");
#endif
        return {};
    }

    template <typename ChrT, typename TraitsT, typename AllocT>
    Error open(const string::Str<ChrT, TraitsT, AllocT>& path,
               Mode mode) noexcept {
        close();

        int oflag = 0;
        int lockType = {};
        switch (mode) {
            case Mode::STAT:
                oflag = O_RDONLY;
                break;

            case Mode::READ:
                oflag = O_RDONLY;
                lockType = LOCK_SH;
                break;

            case Mode::WRITE:
                oflag = O_RDWR | O_TRUNC | O_CREAT;
                lockType = LOCK_EX;
                break;

            case Mode::UPDATE:
                oflag = O_RDWR;
                lockType = LOCK_EX;
                break;

            default:
                return APERRT(Ec::InvalidParam, _location, "Invalid open mode");
        }

        // Don`t follow symlinks
        // Generally, it might not be needed because other was fixed:
        // `statx` call was following symbolic link, and it should not
        oflag |= O_NOFOLLOW;

        // Open the file
        mode_t newFileOpenMode =
            S_IRUSR | S_IWUSR | S_IRGRP | S_IWGRP | S_IROTH;
        m_hFile = ::open(path, oflag, newFileOpenMode);
        if (m_hFile == -1) {
            return APERRT(errno, "Open", path);
        }

        // Close the file if we subsequently fail
        util::Guard cleanup{[&] { close(); }};

        // Lock the file
        if (lockType) {
            auto res = ::flock(m_hFile, lockType | LOCK_NB);
            if (res == -1)
                return APERRT(errno, "Unable to lock file", path, lockType);
            m_locked = true;
        }

        cleanup.cancel();
        return {};
    }

    ErrorOr<size_t> seek(uint64_t offset, int whence) const noexcept {
        auto res = ::lseek(m_hFile, offset, whence);
        if (res == -1) return APERRT(errno, "Seek offset", offset);
        return _cast<size_t>(res);
    }

    ErrorOr<size_t> readAt(uint64_t offset, OutputData data) const noexcept {
        ASSERT(data.size() <= MaxIOSize);

        auto res = ::pread(m_hFile, data, data.size(), offset);
        if (res == -1) return APERRT(errno, "Read offset", offset, data.size());
        return _cast<size_t>(res);
    }

    ErrorOr<size_t> read(OutputData data) const noexcept {
        ASSERT(data.size() <= MaxIOSize);

        auto res = ::read(m_hFile, data, data.size());
        if (res == -1) return APERRT(errno, "Read", data.size());
        return _cast<size_t>(res);
    }

    Error write(InputData data) noexcept {
        ASSERT(data.size() <= MaxIOSize);

        auto res = ::write(m_hFile, data, data.size());
        if (res == -1) return APERRT(errno, "Write", data.size());

        if (res != data.size())
            return APERRT(Ec::Write, "Partial write", data.size());

        return {};
    }

    Error writeAt(uint64_t offset, InputData data) noexcept {
        ASSERT(data.size() <= MaxIOSize);

        auto res = ::pwrite(m_hFile, data, data.size(), offset);
        if (res == -1)
            return APERRT(errno, "Write offset", offset, data.size());

        if (res != data.size())
            return APERRT(Ec::Write, "Partial write", offset, data.size());

        return {};
    }

    ErrorOr<uint64_t> size() const noexcept {
        auto res = stat();
        if (res) return _cast<uint64_t>(res->st_size);
        return res.ccode();
    }

    ErrorOr<PlatStatInfo> stat() const noexcept {
        PlatStatInfo info;
        if (::fstat(m_hFile, &info)) return APERRT(errno, "fstat");
        return info;
    }

    Error truncate(uint64_t offset) noexcept {
        if (::ftruncate(m_hFile, offset))
            return APERRT(errno, "Failed to truncate at offset", offset);
        return {};
    }

    Error mapInit(Mode mode, uint64_t requestedSize,
                  Opt<Ref<uint64_t>> adjustedMapSize = {}) noexcept {
        if (requestedSize == 0) return {};

        if (m_map)
            return APERRT(Ec::InvalidParam, "Mapping already established");

        auto mapSize = alignUp(requestedSize, plat::pageSize());

        if (isReadMode(mode)) {
            auto length = size();
            if (!length) return length.ccode();
            mapSize = std::min(*length, mapSize);
        } else {
            if (::ftruncate(m_hFile, requestedSize))
                return APERRT(errno, "Failed to grow mapped file to offset",
                              requestedSize);
        }

        if (adjustedMapSize) adjustedMapSize->get() = mapSize;

        auto buff =
            ::mmap(0, mapSize, PROT_READ | (isWriteMode(mode) ? PROT_WRITE : 0),
                   MAP_SHARED, m_hFile, 0);

        if (buff == MAP_FAILED)
            return APERRT(errno, "Failed to map file", mapSize);

        LOGT("Initialized mapping of size {,s}({,c}) {}", mapSize, mapSize,
             mode);

        m_map = {buff, mapSize};
        m_mapMode = mode;
        return {};
    }

    ErrorOr<MappedCtx> map(Mode mode, uint64_t requestedOffset,
                           uint64_t requestedSize) noexcept {
        if (requestedOffset == 0 && requestedSize == 0)
            return MappedCtx{mode, nullptr, requestedOffset, requestedSize};

        if (!m_map) {
            if (auto ccode = mapInit(mode, requestedSize, requestedSize))
                return ccode;
        }

        if (isWriteMode(mode) != isWriteMode(m_mapMode))
            return APERRT(Ec::Bug, "Map initialized in different mode", mode,
                          m_mapMode);

        // Round up due to page restrictions
        auto offset = requestedOffset;
        auto size = requestedSize;
        if (isWriteMode(mode)) {
            offset = alignUp(requestedOffset, plat::pageSize());
            size = alignUp(requestedSize, plat::pageSize());
        }

        // Slice off a chunk
        auto chunk = m_map.sliceAt(offset, size);
        if (chunk.size() != size)
            return APERRT(Ec::Bug, "Not enough room in map for offset/size",
                          offset, size, m_map.size());

        LOGT("Mapped offset {,c}({,s}) => {,c}({,s}) {}", offset, offset, size,
             size, mode);

        return MappedCtx{mode, chunk, offset, size};
    }

    void unmap(Opt<Ref<MappedCtx>> ctx = {}) noexcept {
        if (m_map) {
            ::munmap(m_map, 1 << 10);
            m_map.reset();
        }
        m_mapMode = Mode::NONE;
    }

    auto handle() const noexcept { return m_hFile; }

private:
    File& move(File&& file) noexcept {
        if (this == &file) return *this;

        close();
        m_hFile = _exch(file.m_hFile, -1);
        m_map = _exch(file.m_map, {});
        m_mapMode = _exch(file.m_mapMode, Mode::NONE);
        return *this;
    }

    int m_hFile = -1;
    OutputData m_map;
    Mode m_mapMode = Mode::NONE;
    bool m_locked = {};
};

}  // namespace ap::file::stream
