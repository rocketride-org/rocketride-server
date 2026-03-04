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
#include <dirent.h>
namespace ap::file::scan {

// A low level representation of a DIR used for
// scanning the filesystem
template <typename ChrT = Utf8Chr, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::File>
struct File final {
    using EntryType = StatInfo;
    using PathType = FilePath<ChrT, AllocT>;
    using StrType = typename PathType::StrType;
    _const auto LogLevel = LevelT;

    // Close on destruction
    ~File() noexcept { close(); }

    // Opens a scan operation on a path
    Error open(const PathType &path, bool dirOnly = false) noexcept {
        close();

        m_path = path;
        m_parentPath = path.parent();

        LOGT("Open {} parent {}", m_path, m_parentPath);

        if (!(m_dir = ::opendir(m_parentPath.plat())))
            return APERRT(errno, "opendir", path);

        m_dirOnly = dirOnly;

        return {};
    }

    // Read another directory entry from the open scan
    Error read(StrType &name, EntryType &entry) noexcept {
        if (!m_dir) return APERRT(Ec::InvalidState, "File scanner not open");

        while (auto ent = ::readdir(m_dir)) {
            if (ent->d_name[0] == '.' &&
                (!ent->d_name[1] || ent->d_name[1] == '.'))
                continue;
            if (!globber::template glob<string::Case,
                                        globber::GlobFlags::LEADING_DIR>(
                    m_path.fileName(), ent->d_name))
                continue;
            name = ent->d_name;
            ASSERT(name);
            auto info = stat(pathOf(name));
            if (!info) continue;
            if (m_dirOnly && !info->isDir) continue;
            entry = _mv(*info);
            return {};
        }

        return APERRT(Ec::End, "readdir");
    }

    PathType pathOf(const StrType &name) const noexcept {
        return m_parentPath / name;
    }

    // Close a directory scan
    void close() noexcept {
        if (auto d = _exch(m_dir, nullptr)) {
            ::closedir(d);
            m_path = {};
            m_parentPath = {};
        }
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "FileScanner[" << m_path << "]";
    }

private:
    PathType m_path;
    PathType m_parentPath;
    DIR *m_dir = nullptr;
    bool m_dirOnly = false;
};

}  // namespace ap::file::scan