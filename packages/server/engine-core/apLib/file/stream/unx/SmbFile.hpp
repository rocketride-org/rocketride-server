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

class SmbFile {
public:
    // Mapped IO not supported for SMB files
    struct MappedCtx {};

    _const auto LogLevel = Lvl::FileStream;
    // We have a much more stable SMB connection with smaller packet sizes
    _const auto MaxIOSize = 64_kb;

    SmbFile() = default;

    template <typename ChrT, typename TraitsT, typename AllocT>
    SmbFile(const string::Str<ChrT, TraitsT, AllocT>& path,
            Mode mode) noexcept(false) {
        *open(path, mode);
    }

    ~SmbFile() noexcept { close(); }

    SmbFile(const SmbFile&) = delete;

    SmbFile(SmbFile&& file) noexcept { move(_mv(file)); }

    SmbFile& operator=(const SmbFile&) = delete;

    SmbFile& operator=(SmbFile&& file) noexcept { return move(_mv(file)); }

    Error close(bool flush = false) noexcept {
        m_path = "";
        m_mode = Mode::NONE;
        m_offset = {};

        if (auto h = _exch(m_hFile, -1); h != -1)
            return smb::client().closeFile(h);

        return {};
    }

    Error flush() noexcept {
        // Not supported, but also not needed because all data is flushed as
        // it's written, so don't return an error
        return {};
    }

    Error open(const Path& path, Mode mode) noexcept {
        close();

        int oflag = 0;
        switch (mode) {
            case Mode::STAT:
                oflag = O_RDONLY;
                break;

            case Mode::READ:
                oflag = O_RDONLY;
                break;

            case Mode::WRITE:
                oflag = O_RDWR | O_TRUNC | O_CREAT;
                break;

            case Mode::UPDATE:
                oflag = O_RDWR;
                break;

            default:
                return APERRT(Ec::InvalidParam, _location, "Invalid open mode");
        }

        // Open the file
        mode_t newFileOpenMode =
            S_IRUSR | S_IWUSR | S_IRGRP | S_IWGRP | S_IROTH;
        auto hFile = smb::client().openFile(path, oflag, newFileOpenMode);
        if (!hFile) return hFile.ccode();
        m_hFile = *hFile;
        m_path = path;
        m_mode = mode;
        m_offset = {};
        return {};
    }

    ErrorOr<size_t> seek(uint64_t offset, int whence) const noexcept {
        if (auto pos = smb::client().seekFile(m_hFile, offset, whence);
            pos.check())
            return pos;
        else {
            m_offset = _mv(*pos);
            return _cast<size_t>(m_offset);
        }
    }

    ErrorOr<size_t> read(OutputData data) const noexcept {
        ASSERT(data.size() <= MaxIOSize);
        auto res = smb::client().readFile(m_hFile, data);
        if (res) {
            m_offset += *res;
            return res;
        }

        if (res.ccode() != ECONNABORTED) return res;

        // If we failed with ECONNABORTED, close and reopen the file and retry
        // the read [APPLAT-435]
        LOGT("SMB read failed with ECONNABORTED; reconnecting and retrying");

        // Save stream configuration before closing
        auto path = m_path;
        auto mode = m_mode;
        auto offset = m_offset;

        // const cast to close and re-open
        const_cast<SmbFile&>(*this).close();
        if (auto ccode = const_cast<SmbFile&>(*this).open(path, mode))
            return ccode;

        // Finally, seek back to where we were and read the requested data
        return readAt(offset, data);
    }

    ErrorOr<size_t> readAt(uint64_t offset, OutputData data) const noexcept {
        ASSERT(data.size() <= MaxIOSize);
        if (auto pos = seek(offset, SEEK_SET); pos.check()) return pos.ccode();
        return read(data);
    }

    Error write(InputData data) noexcept {
        ASSERT(data.size() <= MaxIOSize);
        if (auto ccode = smb::client().writeFile(m_hFile, data)) return ccode;
        m_offset += data.size();
        return {};
    }

    Error writeAt(uint64_t offset, InputData data) noexcept {
        ASSERT(data.size() <= MaxIOSize);
        if (auto pos = seek(offset, SEEK_SET); pos.check()) return pos.ccode();
        return write(data);
    }

    ErrorOr<uint64_t> size() const noexcept {
        auto res = stat();
        if (res) return _cast<uint64_t>(res->st_size);
        return res.ccode();
    }

    ErrorOr<PlatStatInfo> stat() const noexcept {
        return smb::client().fstat(m_hFile);
    }

    /*ErrorOr<struct sec_desciptor> getAcls(Path path) const noexcept {
        return
    smb::client().getAcl(Text(path.at(0)),Text(path.at(1)),Text(path.subpth(2)));
    }*/

    Error truncate(uint64_t offset) noexcept {
        if (auto ccode = smb::client().truncateFile(m_hFile, offset))
            return ccode;
        m_offset = {};
        return {};
    }

    Error mapInit(Mode mode, uint64_t requestedSize,
                  Opt<Ref<uint64_t>> adjustedMapSize = {}) noexcept {
        return APERRT(Ec::NotSupported,
                      "Mapped IO not supported for SMB files");
    }

    ErrorOr<MappedCtx> map(Mode mode, uint64_t requestedOffset,
                           uint64_t requestedSize) noexcept {
        return APERRT(Ec::NotSupported,
                      "Mapped IO not supported for SMB files");
    }

    void unmap(Opt<Ref<MappedCtx>> ctx = {}) noexcept {
        LOGT("Cannot unmap; mapped IO not supported for SMB files");
    }

    auto handle() const noexcept { return m_hFile; }

private:
    SmbFile& move(SmbFile&& file) noexcept {
        if (this == &file) return *this;

        close();

        m_hFile = _exch(file.m_hFile, -1);
        m_offset = _exch(file.m_offset, 0);
        m_path = _exch(file.m_path, Text{});
        m_mode = _exch(file.m_mode, Mode::NONE);
        return *this;
    }

private:
    int m_hFile = -1;
    Path m_path;
    Mode m_mode = Mode::NONE;
    mutable uint64_t m_offset = {};
};

}  // namespace ap::file::stream
