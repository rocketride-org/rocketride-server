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

// Mac version of the os mount point enumerator
template <typename ChrT = Utf8Chr, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::Volume>
class MountPoint {
public:
    // Null entry type
    using EntryType = void;

    using PathType = FilePath<ChrT, AllocT>;
    using StrType = typename PathType::StrType;

    _const auto LogLevel = LevelT;

    Error open(StrType path) noexcept {
        // According to the getmntinfo man page, this doesn't need to be freed
        m_statFsCount = getmntinfo(&m_statFs, 0);
        return {};
    }

    Error read(StrType &name) noexcept {
        if (m_statFsPos == m_statFsCount) return APERRT(Ec::End, "End of scan");

        auto currentStat = m_statFs[m_statFsPos++];

        Text fsName = currentStat.f_mntfromname;
        Text mountedOn = currentStat.f_mntonname;

        // If this file system or mount dir was already counted - skip
        if (m_fsUsed.find(fsName) != m_fsUsed.end() ||
            m_mountDirUsed.find(mountedOn) != m_mountDirUsed.end())
            return read(name);

        // Insert the new file system name to the set
        m_fsUsed.emplace(_mv(fsName));
        m_mountDirUsed.insert(mountedOn);

        // Only add the ones you can stat and are valid (non 0 size)
        struct stat s;
        if (stat(mountedOn, &s) != 0 || s.st_size == 0) return read(name);

        name = _mv(mountedOn);
        return {};
    }

    void close() noexcept {}

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "MountPointScanner";
    }

private:
    int m_statFsCount = 0;
    int m_statFsPos = 0;
    struct statfs *m_statFs = nullptr;
    std::set<Text> m_fsUsed;
    std::set<Text> m_mountDirUsed;
};

}  // namespace ap::file::scan
