// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

// A low level representation of a DIR used for
// scanning the filesystem
template <typename ChrT = Utf8Chr, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::File>
struct File final {
    using EntryType = StatInfo;
    using PathType = FilePath<ChrT, AllocT>;
    using StrType = typename PathType::StrType;
    using ViewType = typename PathType::ViewType;

    _const auto LogLevel = LevelT;

    // Open a find operation
    Error open(const PathType &path, bool dirOnly = false) noexcept {
        close();

        m_hFind.reset(::FindFirstFileExW(
            path.plat(), FindExInfoBasic, &m_entry,
            dirOnly ? FindExSearchLimitToDirectories : FindExSearchNameMatch,
            nullptr, FIND_FIRST_EX_LARGE_FETCH));

        if (!m_hFind)
            return APERRT(::GetLastError(), "FindFirstFileExW failed",
                          path.plat());

        // We loaded one but we're not returning it yet, flag it for
        // first call to read
        m_first = true;

        m_path = path;
        m_parentPath = path.parent();
        m_dirOnly = dirOnly;
        return {};
    }

    // Reads another entry from an open find file handle
    Error read(StrType &name, EntryType &entry) noexcept {
        if (!m_hFind) return APERRT(Ec::InvalidState, "File scanner not open");
        while (_exch(m_first, false) ||
               ::FindNextFileW(m_hFind.get(), &m_entry)) {
            if (m_dirOnly &&
                !(m_entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
                continue;

            if (wcscmp(m_entry.cFileName, L".") == 0 ||
                wcscmp(m_entry.cFileName, L"..") == 0)
                continue;

            name = m_entry.cFileName;
            entry = _tr<EntryType>(m_entry, pathOf(name));

            return {};
        }

        return APERR(Ec::End);
    }

    PathType pathOf(const StrType &name) const noexcept {
        return m_parentPath / name;
    }

    // Closes the find operation
    void close() noexcept {
        m_hFind.reset();
        m_path = {};
        m_parentPath = {};
        m_first = false;
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "FileScanner[" << m_path << "]";
    }

private:
    bool m_first = false;
    PathType m_path;
    PathType m_parentPath;
    bool m_dirOnly = false;
    ::WIN32_FIND_DATAW m_entry;
    wil::unique_hfind m_hFind;
};

}  // namespace ap::file::scan
