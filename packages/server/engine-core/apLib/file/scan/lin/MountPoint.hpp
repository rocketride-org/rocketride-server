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

// Linux version of the os mount point enumerator
template <typename ChrT = Utf8Chr, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::Volume>
class MountPoint {
public:
    // Null entry type
    using EntryType = void;

    using PathType = FilePath<ChrT, AllocT>;
    using StrType = typename PathType::StrType;

    _const auto LogLevel = LevelT;

    // Close on destruct
    ~MountPoint() noexcept { close(); }

    Error open(StrType path) noexcept {
        // Close the last one if started already
        close();

        m_mntent = setmntent("/proc/mounts", "r");
        if (!m_mntent) return APERR(errno, "FSY: Failed setmntent");

        return {};
    }

    Error read(StrType& name) noexcept {
        if (!m_mntent) return APERRT(Ec::InvalidState, "Not open");

        struct mntent* ent = getmntent(m_mntent);
        if (!ent) return APERRT(Ec::End, "End of scan");

        Text fsName = ent->mnt_fsname;
        Text mountedOn = ent->mnt_dir;

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

    // Reset closes the find handle if it isn't already closed
    void close() noexcept {
        if (m_mntent) {
            endmntent(m_mntent);
            m_mntent = nullptr;
        }
        m_fsUsed.clear();
        m_mountDirUsed.clear();
    }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << "MountPointScanner";
    }

private:
    FILE* m_mntent = nullptr;
    std::set<Text> m_fsUsed;
    std::set<Text> m_mountDirUsed;
};

}  // namespace ap::file::scan
