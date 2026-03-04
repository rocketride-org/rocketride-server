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

#include <apLib/ap.h>

using namespace ap;
using namespace ap::file;

namespace ap::file {

// forward declarations
SharedPtr<MntEntInfoCache> refreshMounting() noexcept;

}  // namespace ap::file

namespace {

// Mapping of file system as defined by *nix to enumeration
_const std::array<Pair<ap::file::FsType, TextView>, 52> g_fsExtLookupNames = {
    {{FsType::Auto, "auto"},
     {FsType::Adfs, "adfs"},
     {FsType::Affs, "affs"},
     {FsType::Afpfs, "afpfs"},
     {FsType::Autofs, "autofs"},
     {FsType::BinfmtMisc, "binfmt_misc"},
     {FsType::Bpf, "bpf"},
     {FsType::Cifs, "cifs"},
     {FsType::Coda, "coda"},
     {FsType::Cramfs, "cramfs"},
     {FsType::Cgroup, "cgroup"},
     {FsType::Configfs, "configfs"},
     {FsType::Debugfs, "debugfs"},
     {FsType::Devpts, "devpts"},
     {FsType::Devtmpfs, "devtmpfs"},
     {FsType::Efs, "efs"},
     {FsType::Ext2, "ext2"},
     {FsType::Ext3, "ext3"},
     {FsType::Ext4, "ext4"},
     {FsType::Fuse, "fuse"},
     {FsType::Fusectl, "fusectl"},
     {FsType::FuseGvfsdFuse, "fuse.gvfsd-fuse"},
     {FsType::FuseVmwareVmblock, "fuse.vmware-vmblock"},
     {FsType::Hfs, "hfs"},
     {FsType::Hpfs, "hpfs"},
     {FsType::Hugetlbfs, "hugetlbfs"},
     {FsType::Iso9660, "iso9660"},
     {FsType::Jfs, "jfs"},
     {FsType::Minix, "minix"},
     {FsType::Mqueue, "mqueue"},
     {FsType::Msdos, "msdos"},
     {FsType::Ncpfs, "ncpfs"},
     {FsType::Nfs, "nfs"},
     {FsType::Nfs4, "nfs4"},
     {FsType::Ntfs, "ntfs"},
     {FsType::Proc, "proc"},
     {FsType::Qnx4, "qnx4"},
     {FsType::Reiserfs, "reiserfs"},
     {FsType::Romfs, "romfs"},
     {FsType::Securityfs, "securityfs"},
     {FsType::Smbfs, "smbfs"},
     {FsType::Sqashfs, "squashfs"},
     {FsType::Sysfs, "sysfs"},
     {FsType::Sysv, "sysv"},
     {FsType::Tmpfs, "tmpfs"},
     {FsType::Udf, "udf"},
     {FsType::Ufs, "ufs"},
     {FsType::Umsdos, "umsdos"},
     {FsType::Vfat, "vfat"},
     {FsType::Xfs, "xfs"},
     {FsType::Xiafs, "xiafs"},
     {FsType::Unknown, "unknown"}}

};

// Reference holder for the cached data
struct MountHolder final {
    mutable async::MutexLock m_lock;
    MntEntInfoCachePtr m_cache = refreshMounting();
};

// Given a device id, obtain cache reference and iterator mapping to the mount
// information
ErrorOr<MntEntInfoHolder> getGlobalCacheMntEnt(uint64_t deviceId) noexcept {
    static MountHolder singleton;

    SharedPtr<MntEntInfoCache> current;

    _using(auto guard = singleton.m_lock.lock()) {
        current = singleton.m_cache;
    }

    if (auto found = current->mapping.find(deviceId);
        found != current->mapping.end()) {
        auto& info = (*found).second;
        LOG(File, "found mount mapping", info.deviceId, info.name,
            info.mountPath, info.removable);
        return MntEntInfoHolder{current, found};
    }

    current = refreshMounting();

    _using(auto guard = singleton.m_lock.lock()) {
        singleton.m_cache = current;
    }

    if (auto found = current->mapping.find(deviceId);
        found != current->mapping.end()) {
        auto& info = (*found).second;
        LOG(File, "found mount mapping after refresh", info.deviceId, info.name,
            info.mountPath, info.removable);
        return MntEntInfoHolder{current, found};
    }

    return APERR(Ec::NotFound, "Mount for the device id specified is not found",
                 deviceId);
}

}  // namespace

namespace ap::file {

// Return if a file system type is by its nature removable.
Opt<bool> isRemovable(FsType type) noexcept {
    switch (type) {
        case FsType::Auto:
        case FsType::Autofs:
        case FsType::Afpfs:
        case FsType::BinfmtMisc:
        case FsType::Bpf:
        case FsType::Cifs:
        case FsType::Coda:
        case FsType::Cgroup:
        case FsType::Configfs:
        case FsType::Debugfs:
        case FsType::Devtmpfs:
        case FsType::Efs:
        case FsType::Fuse:
        case FsType::Fusectl:
        case FsType::FuseGvfsdFuse:
        case FsType::Hugetlbfs:
        case FsType::Mqueue:
        case FsType::Ncpfs:
        case FsType::Nfs:
        case FsType::Nfs4:
        case FsType::Proc:
        case FsType::Smbfs:
        case FsType::Sysfs:
        case FsType::Tmpfs:
        case FsType::Udf:
            return true;

        case FsType::Adfs:
        case FsType::Affs:
        case FsType::Cramfs:
        case FsType::Devpts:
        case FsType::Ext2:
        case FsType::Ext3:
        case FsType::Ext4:
        case FsType::Hfs:
        case FsType::Hpfs:
        case FsType::Iso9660:
        case FsType::Jfs:
        case FsType::Minix:
        case FsType::Msdos:
        case FsType::Ntfs:
        case FsType::Qnx4:
        case FsType::Reiserfs:
        case FsType::Romfs:
        case FsType::Securityfs:
        case FsType::Sqashfs:
        case FsType::Sysv:
        case FsType::Ufs:
        case FsType::Umsdos:
        case FsType::Vfat:
        case FsType::Xfs:
        case FsType::Xiafs:
        case FsType::Unknown:
            break;
    }
    return {};
}

// Given a list of file system types, returns if the file system is removable
Opt<bool> isRemovable(const std::vector<FsType>& types) noexcept {
    for (auto& type : types) {
        auto result = isRemovable(type);
        if (result) return result;
    }
    return {};
}

// Given a file system name, returns the file system type
FsType toFsType(TextView str) noexcept {
    for (auto& ext : g_fsExtLookupNames) {
        if (ext.second == str) return ext.first;
    }
    return FsType::Unknown;
}

// Given an array of file names separated by comma, returns the array of file
// system types
std::vector<FsType> toFsTypeArray(TextView str) noexcept {
    std::vector<FsType> result;
    auto types = split(str, ",");
    for (auto& type : types) {
        result.push_back(toFsType(str));
    }
    return result;
}

// Given a path, return the mount information for its related file system
ErrorOr<MntEntInfo> getMntEntInfo(const Path& path) noexcept {
    struct stat pathStat{};
    if (::stat(path.str(), &pathStat) != 0)
        return APERR(errno, "Failed to stat path", path);
    auto result = getGlobalCacheMntEnt(_cast<uint64_t>(pathStat.st_dev));
    if (result.hasCcode()) return result.check();
    return (*(result->infoIter)).second;
}

// Given a path, return if the path is on a removable device
bool isOnRemovableDrive(const Path& path) noexcept {
    struct stat pathStat{};
    if (::stat(path.str(), &pathStat) != 0) return false;
    auto result = getGlobalCacheMntEnt(_cast<uint64_t>(pathStat.st_dev));
    if (result.hasCcode()) return false;
    return (*(result->infoIter)).second.removable;
}

}  // namespace ap::file
