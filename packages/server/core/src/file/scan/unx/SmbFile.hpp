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

namespace ap::file::scan {

// Scanner for SMB
template <typename ChrT = Utf8Chr, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::File>
struct SmbFile final {
    using EntryType = StatInfo;
    using PathType = FilePath<ChrT, AllocT>;
    using StrType = typename PathType::StrType;
    _const auto LogLevel = LevelT;

    // Close on destruction
    ~SmbFile() noexcept { close(); }

    // Opens a scan operation on a path
    Error open(const PathType &path, bool dirOnly = false) noexcept {
        close();

        m_path = path;
        m_parentPath = path.parent();

        LOGT("Open {}, parent {}", m_path, m_parentPath);
        auto handle = smb::client().openDirectory(m_parentPath);
        if (!handle) return handle.ccode();

        m_handle = *handle;
        m_dirOnly = dirOnly;
        return {};
    }

    // Read another directory entry from the open scan
    Error read(StrType &name, EntryType &entry) noexcept {
        return smb::client().hasReadplus2Directory()
                   ? readplus2Impl(name, entry)
                   : readImpl(name, entry);
    }
    // Read using read / stat
    Error readImpl(StrType &name, EntryType &entry) noexcept {
        _forever() {
            // Behold, the Sub-Mariner
            auto nameOr = smb::client().readDirectory(m_handle);
            if (!nameOr) return nameOr.ccode();

            name = *nameOr;
            if (name[0] == '.' && (!name[1] || name[1] == '.')) continue;
            if (!globber::template glob<string::Case,
                                        globber::GlobFlags::LEADING_DIR>(
                    m_path.fileName(), name))
                continue;

            auto info = stat(pathOf(name));
            if (!info) continue;
            if (m_dirOnly && !info->isDir) continue;

            entry = _mv(*info);
            return {};
        }
    }
    // Read using read / stat
    Error readplus2Impl(StrType &name, EntryType &entry) noexcept {
        PlatStatInfo platStatInfo;

        _forever() {
            // Behold, the Sub-Mariner
            auto nameOr =
                smb::client().readplus2Directory(m_handle, platStatInfo);
            if (!nameOr) return nameOr.ccode();

            name = *nameOr;
            if (name == "." || name == "..") continue;

            if (!globber::template glob<string::Case,
                                        globber::GlobFlags::LEADING_DIR>(
                    m_path.fileName(), name))
                continue;

            if (m_dirOnly && !(platStatInfo.st_mode & S_IFDIR)) continue;

            entry = _tr<StatInfo>(platStatInfo, name);
            return {};
        }
    }

    PathType pathOf(const StrType &name) const noexcept {
        return m_parentPath / name;
    }

    // Close a directory scan
    void close() noexcept {
        if (auto h = _exch(m_handle, 0)) {
            smb::client().closeDirectory(h);
            m_path = {};
            m_parentPath = {};
        }
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "SmbFileScanner[" << m_path << "]";
    }

private:
    PathType m_path;
    PathType m_parentPath;
    int m_handle = {};
    bool m_dirOnly = false;
};

template <typename ChrT, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::File>
using SmbFileScanner = Scanner<ChrT, AllocT, LevelT, SmbFile>;

}  // namespace ap::file::scan

namespace ap::file {
using SmbFileScanner = scan::SmbFileScanner<TextChr>;
}