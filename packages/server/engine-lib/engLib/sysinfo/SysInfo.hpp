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

namespace engine {

struct SysInfo {
    Text platform;
    std::map<Text, plat::DiskUsage> diskStats;
    std::map<Text, plat::DiskUsage> systemPathStats;
    int systemDiskUtilization = {};
    int systemCPUCount = {};
    int systemGPUSize = {};

    Error __toJson(json::Value& val) const noexcept {
        val["platform"] = platform;
        val["nCPUCores"] = systemCPUCount;
        val["GPUSize"] = systemGPUSize;
        val["diskUtilization"] = systemDiskUtilization;

        auto diskUsageToJson = [](TextView path, const plat::DiskUsage& du,
                                  bool includeUtiliation =
                                      true) -> json::Value {
            json::Value json;
            json["path"] = path;
            json["diskSize"] = du.spaceTotal / 1_gb;
            json["diskFree"] = du.spaceFree / 1_gb;
            json["diskUsed"] = (du.spaceTotal / 1_gb) - (du.spaceFree / 1_gb);
            if (includeUtiliation) json["diskUtilization"] = du.utilization;
            return json;
        };

        for (auto& [path, du] : diskStats) {
            val["disks"].append(diskUsageToJson(path, du));
        }

        for (auto& [path, du] : systemPathStats) {
            val["paths"][path] = diskUsageToJson(path, du, false);
        }

        return {};
    }

    static Error __fromJson(SysInfo& key, const json::Value& val) noexcept {
        if (!val.isObject())
            return APERR(Ec::InvalidJson, "Expected object", val);

        if (auto ccode = val.lookupAssign("platform", key.platform))
            return ccode;

        int systemDiskUtilization = {};
        if (!val.lookupAssign("diskUtilization", systemDiskUtilization))
            key.systemDiskUtilization = systemDiskUtilization;

        auto diskUsageFromJson = [](const json::Value& json)
            -> ErrorOr<std::pair<Text, plat::DiskUsage>> {
            Text path;
            Size diskSize, diskFree;
            int utilization = 0;
            if (auto ccode = json.lookupAssign("path", path) ||
                             json.lookupAssign("diskSize", diskSize) ||
                             json.lookupAssign("diskFree", diskFree) ||
                             json.lookupAssign("diskUtilization", utilization))
                return ccode;

            return std::make_pair<Text, plat::DiskUsage>(
                _mv(path), {diskSize * 1_gb, diskFree * 1_gb, utilization});
        };

        for (auto& item : val["disks"]) {
            auto du = diskUsageFromJson(item);
            if (!du) return du.ccode();

            key.diskStats.insert(_mv(*du));
        }

        auto& paths = val["paths"];
        if (paths) {
            TextView sysPaths[] = {"data"_tv, "control"_tv, "cache"_tv,
                                   "log"_tv};
            for (auto& item : sysPaths) {
                auto& path = paths[item];
                if (!path) continue;

                auto du = diskUsageFromJson(path);
                if (!du) return du.ccode();

                key.systemPathStats.insert(_mv(*du));
            }
        }

        return {};
    };
};

inline ErrorOr<SysInfo> sysInfo() {
    SysInfo info;

    auto platform = plat::osVersion();
    if (!platform)
        return platform.ccode();
    else
        info.platform = _mv(platform);

    if (auto systemDiskUtilization = plat::systemDiskUtilization())
        info.systemDiskUtilization = *systemDiskUtilization;

    if (auto systemCPUCount = plat::cpuCount())
        info.systemCPUCount = systemCPUCount;

    if (auto systemGPUSize = plat::gpuSize())
        info.systemGPUSize = systemGPUSize;

#ifdef ROCKETRIDE_PLAT_WIN
    using DiskScanner = file::DriveLetterScanner;
#else
    using DiskScanner = file::MountPointScanner;
#endif

    DiskScanner diskScanner;
    if (auto ccode = diskScanner.open()) return ccode;
    while (auto disk = diskScanner.next()) {
        if (auto diskUsage = plat::diskUsage(*disk))
            info.diskStats.emplace(*disk, _mv(diskUsage));
    }

    // Get the free space on all of our system paths
    TextView sysPaths[] = {"data"_tv, "control"_tv, "cache"_tv, "log"_tv};
    for (auto& item : sysPaths) {
        auto diskInfo = plat::diskUsage(config::paths().lookup(item));
        if (diskInfo) info.systemPathStats.emplace(item, _mv(diskInfo));
    }

    return info;
}

}  // namespace engine
