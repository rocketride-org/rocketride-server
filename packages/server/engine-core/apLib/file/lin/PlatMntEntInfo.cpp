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

#include <apLib/ap.h>

using namespace ap;
using namespace ap::file;

namespace {

// Linux file system defaults for obtaining mounted file system information
_const auto MntEntryPath = _PATH_MOUNTED;
_const auto MntDevPrefix = "/dev/"_tv;
_const auto MntSysBlockRemovablePrefix = "/sys/block/"_tv;
_const auto MntSysBlockRemovablePostfix = "/removable"_tv;

}  // namespace

namespace ap::file {

// Obtain refreshed information about the mounted file systems
SharedPtr<MntEntInfoCache> refreshMounting() noexcept {
    auto result = makeShared<MntEntInfoCache>();

    auto file = ::setmntent(MntEntryPath, "r");
    if (!file) {
        LOG(File, "setmntent failed", errno);
        return result;
    }

    while (auto mnt = ::getmntent(file)) {
        struct stat devStat{};
        if (::stat(mnt->mnt_dir, &devStat) != 0) {
            LOG(File, "stat failed", errno, mnt->mnt_dir, mnt->mnt_fsname);
            continue;
        }
        MntEntInfo info{*mnt};
        info.deviceId = _cast<decltype(info.deviceId)>(devStat.st_dev);
        info.name = mnt->mnt_fsname;
        info.mountPath = mnt->mnt_dir;
        info.mountOptions = string::split(mnt->mnt_opts, ",");
        info.types = toFsTypeArray(mnt->mnt_type);
        auto removable = isRemovable(info.types);
        if (!removable) {
            if (MntDevPrefix == info.name.substr(0, MntDevPrefix.length())) {
                auto subname = info.name.substr(MntDevPrefix.length());
                size_t length = 0;

                for (; subname.length() > 0;
                     subname = subname.substr(0, subname.length() - 1)) {
                    auto fullName = MntSysBlockRemovablePrefix + subname +
                                    MntSysBlockRemovablePostfix;
                    struct stat remStat{};
                    if (::stat(fullName, &remStat) != 0) {
                        LOG(File,
                            "device mount stat not available (ignored as "
                            "likely not a valid dev)",
                            fullName);
                        continue;
                    }

                    // file exists, so read the contents to see if it contains
                    // "0" or not
                    if (auto digit = file::fetchString(fullName); digit) {
                        info.removable = ((*digit).substr(0, 1) != "0");
                        LOG(File, "found removable flag file and read flag",
                            info.removable, fullName, digit);
                    }
                    break;
                }
            }
        } else
            info.removable = *removable;

        LOG(File, "mount information", info.deviceId, info.name, info.mountPath,
            info.types.size() > 0 ? info.types[0] : FsType::Unknown,
            info.removable, mnt->mnt_type, mnt->mnt_opts);

        result->items.push_back(info);
        result->mapping[info.deviceId] = info;
    }

    ::endmntent(file);

    return result;
}

}  // namespace ap::file
