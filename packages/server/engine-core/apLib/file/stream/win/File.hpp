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
        if (flush && m_hFile) {
            if (auto ccode = this->flush()) return ccode;
        }

        unmap();

        // Extract the file handle from the smart pointer so we can check for
        // errors while closing
        if (m_hFile && !::CloseHandle(m_hFile.release()))
            return APERRT(::GetLastError(),
                          "Received error while closing file");

        return {};
    }

    Error flush() noexcept {
        if (!FlushFileBuffers(m_hFile.get()))
            return APERRT(::GetLastError(), "Failed to flush data");
        return {};
    }

    template <typename ChrT, typename TraitsT, typename AllocT>
    Error open(const string::Str<ChrT, TraitsT, AllocT>& path,
               Mode mode) noexcept {
        close();

        DWORD access = {}, share = {}, create = {}, flags = {};
        switch (mode) {
            case Mode::STAT:
                share = FILE_SHARE_DELETE | FILE_SHARE_READ | FILE_SHARE_WRITE;
                create = OPEN_EXISTING;
                flags = FILE_FLAG_BACKUP_SEMANTICS;
                break;

            case Mode::READ:
                access = GENERIC_READ;
                share = FILE_SHARE_READ;
                create = OPEN_EXISTING;
                flags = FILE_FLAG_SEQUENTIAL_SCAN;
                break;

            case Mode::WRITE:
                access = GENERIC_READ | GENERIC_WRITE;
                create = CREATE_ALWAYS;
                break;

            case Mode::UPDATE:
                access = GENERIC_READ | GENERIC_WRITE;
                create = OPEN_EXISTING;
                break;

            default:
                return APERRT(Ec::InvalidParam, _location, "Invalid open mode");
        }

        m_hFile.reset(::CreateFileW(path, access, share, nullptr, create, flags,
                                    nullptr));
        if (!m_hFile) return APERRT(::GetLastError(), "Failed to open", path);
        return {};
    }

    Error setOffset(uint64_t offset) noexcept {
        auto [low, high] = util::split64<DWORD, LONG>(offset);

        if (::SetFilePointer(m_hFile.get(), low, &high, SEEK_SET) ==
            INVALID_SET_FILE_POINTER)
            return APERRT(::GetLastError(), "Unable to set file pointer to",
                          offset);
        return {};
    }

    ErrorOr<size_t> read(OutputData data) const noexcept {
        ASSERT(data.size() <= MaxIOSize);

        DWORD sizeRead;
        if (!::ReadFile(m_hFile.get(), data, data.sizeAs<DWORD>(), &sizeRead,
                        nullptr))
            return APERRT(::GetLastError(), "ReadFile");

        return sizeRead;
    }

    ErrorOr<size_t> readAt(uint64_t offset, OutputData data) const noexcept {
        ASSERT(data.size() <= MaxIOSize);

        // Cheating, but there are no const reads of files in Win32-- reading
        // always changes the file pointer
        if (auto ccode = _constCast<File*>(this)->setOffset(offset))
            return ccode;

        return read(data);
    }

    Error write(InputData data) noexcept {
        ASSERT(data.size() <= MaxIOSize);

        DWORD sizeWrite;
        if (!::WriteFile(m_hFile.get(), data, data.sizeAs<DWORD>(), &sizeWrite,
                         nullptr))
            return APERRT(::GetLastError(), "WriteFile");

        if (sizeWrite != data.size())
            return APERRT(Ec::Write, _location, "Partial write", data.size());

        return {};
    }

    Error writeAt(uint64_t offset, InputData data) noexcept {
        ASSERT(data.size() <= MaxIOSize);

        if (auto ccode = setOffset(offset)) return ccode;

        return write(data);
    }

    ErrorOr<uint64_t> size() const noexcept {
        DWORD high;
        auto low = ::GetFileSize(m_hFile.get(), &high);
        if (low == INVALID_FILE_SIZE)
            return APERRT(::GetLastError(), "Failed to get length");
        return (_cast<uint64_t>(high) << 32) + low;
    }

    ErrorOr<uint64_t> sizeAt(uint64_t pos) const noexcept {
        auto len = size();
        if (len.check()) return len.ccode();
        if (*len > pos) return *len - pos;
        return 0ull;
    }

    ErrorOr<::BY_HANDLE_FILE_INFORMATION> stat() const noexcept {
        ::BY_HANDLE_FILE_INFORMATION info;
        if (::GetFileInformationByHandle(m_hFile.get(), &info)) return info;
        return APERRT(::GetLastError(), "Failed to stat");
    }

    auto handle() const noexcept { return m_hFile.get(); }

    Error truncate(uint64_t offset) noexcept {
        if (auto ccode = setOffset(offset)) return ccode;

        if (!::SetEndOfFile(m_hFile.get()))
            return APERRT(::GetLastError(), "Unable to set eof to", offset);

        return {};
    }

    Error mapInit(Mode mode, uint64_t requestedSize,
                  Opt<Ref<uint64_t>> adjustedMapSize = {}) noexcept {
        if (m_hMap)
            return APERRT(Ec::InvalidParam, "Mapping already initialized",
                          m_mappedSize);

        // Turn on sparse mode to allow for compact ranges of data
        if (isCreateMode(mode)) {
            if (!::DeviceIoControl(m_hFile.get(), FSCTL_SET_SPARSE, nullptr, 0,
                                   nullptr, 0, nullptr, nullptr))
                return APERRT(::GetLastError(), "Failed to enable sparse mode");
        }

        // Ignore a request to map a 0 byte file, mapping just 'works'
        if (requestedSize == 0) return {};

        auto mapSize = alignUp(requestedSize, plat::pageSize());

        // Cap it if the file has a size already and we're in read mode
        if (isReadMode(mode)) {
            auto length = size();
            if (length.check()) return length.ccode();
            mapSize = std::min(*length, mapSize);
        }

        if (adjustedMapSize) adjustedMapSize->get() = mapSize;

        if (!mapSize) return {};

        auto [sizeLow, sizeHigh] = util::split64(mapSize);

        LOGT("Creating mapping of size {,s} {,c}", mapSize, mapSize);

        m_hMap.reset(::CreateFileMapping(
            m_hFile.get(), nullptr,
            isWriteMode(mode) ? PAGE_READWRITE : PAGE_READONLY, sizeHigh,
            sizeLow, nullptr));
        if (!m_hMap)
            return APERRT(::GetLastError(), "Failed to create file map of size",
                          mapSize);

        LOGT("Initialized mapping of size {,s} ({,c}) {}", mapSize, mapSize,
             mode);

        m_mappedSize = mapSize;
        return {};
    }

    ErrorOr<MappedCtx> map(Mode mode, uint64_t requestedOffset,
                           uint64_t requestedSize) noexcept {
        auto offset = alignUp(requestedOffset, plat::pageSize());

        // Just return an empty context if the size requested is zero we
        // can't actually map a zero length file (nor does it make sense)
        if (requestedSize == 0) return MappedCtx{mode, nullptr, offset, 0};

        auto currentSize = size();
        if (currentSize.check()) return currentSize.ccode();

        // Round up due to page restrictions
        auto mapSize = requestedSize;
        auto mapOffset = requestedOffset;

        // If in write mode, align up to page boundary
        if (isWriteMode(mode)) {
            mapSize = alignUp(requestedSize, plat::pageSize());
            mapOffset = alignUp(requestedOffset, plat::pageSize());
        }
        // Read mode, verify we're not beyond the file length
        else {
            if (mapOffset + mapSize > *currentSize)
                return APERR(Ec::InvalidParam, "Map size", mapSize,
                             "Map offset", mapOffset, "Exceeds file size",
                             currentSize);
        }

        if (!m_hMap) {
            if (auto ccode = mapInit(mode, mapOffset + mapSize)) return ccode;
        }

        // Ok create the file view
        auto [offsetLow, offsetHigh] = util::split64(mapOffset);

        LOGT("Mapping view from offset {,s} {,c} of size {,s} {,c}", mapOffset,
             mapOffset, mapSize, mapSize);

        auto data = ::MapViewOfFile(
            m_hMap.get(),
            isWriteMode(mode) ? FILE_MAP_ALL_ACCESS : FILE_MAP_READ, offsetHigh,
            offsetLow, _nc<SIZE_T>(mapSize));
        if (!data)
            return APERRT(::GetLastError(), "Failed to map offset", mapOffset,
                          "size", mapSize);

        LOGT("Mapped offset {,c} ({,s}) => {,c} ({,s}) {}", mapOffset,
             mapOffset, mapSize, mapSize, mode);

        // Alright we created a mapping return it
        return MappedCtx{mode, data, mapOffset, mapSize};
    }

    void unmap(Opt<Ref<MappedCtx>> ctx = {}) noexcept {
        if (ctx) {
            // If these fail our assumptions are wrong or there is data
            // corruption
            ASSERTD_MSG(!ctx->get().data || ::UnmapViewOfFile(ctx->get().data),
                        ::GetLastError(), "UnmapViewOfFile");
        } else
            m_hMap.reset();
    }

private:
    File& move(File&& file) noexcept {
        if (this == &file) return *this;

        close();
        m_hFile = _mv(file.m_hFile);
        m_hMap = _mv(file.m_hMap);
        m_mappedSize = _exch(file.m_mappedSize, 0);
        return *this;
    }

    wil::unique_hfile m_hFile;
    wil::unique_handle m_hMap;
    uint64_t m_mappedSize = {};
};

}  // namespace ap::file::stream
