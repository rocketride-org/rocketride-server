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

#include <sys/stat.h>
#include <cstring>
#include <map>
#include <vector>
#include <memory>
#include <sys/mount.h>

namespace ap::file {

template <typename InternalStatT>
struct PlatStatInfoT final : public InternalStatT {
    PlatStatInfoT(const InternalStatT &info) noexcept {
        std::memcpy(this, &info, sizeof(info));
    }
    PlatStatInfoT() noexcept { std::memset(this, 0, sizeof(*this)); }
    PlatStatInfoT &operator=(const InternalStatT &info) noexcept {
        if (&info == this) return *this;
        std::memcpy(this, &info, sizeof(info));
        return *this;
    }
};

typedef struct stat InternalStat;
typedef PlatStatInfoT<InternalStat> PlatStatInfo;
#ifdef ROCKETRIDE_PLAT_MAC
// Define PlatMntEntInfo using struct statfs for macOS
typedef struct ::statfs PlatMntEntInfo;
typedef PlatStatInfoT<InternalStat> PlatStatInfoEx;
#else
typedef struct ::statx InternalStatEx;
typedef PlatStatInfoT<InternalStatEx> PlatStatInfoEx;
#endif
// No need to define statx for macOS as it's a Linux-specific extension.

// Forward declarations
struct MntEntInfo;
struct MntEntInfoCache;
using MntEntInfoCachePtr = SharedPtr<MntEntInfoCache>;
using MntEntInfoMap = std::map<dev_t, ap::file::MntEntInfo>;

struct MntEntInfoHolder {
    MntEntInfoCachePtr cache;
    MntEntInfoMap::iterator infoIter;
};

// Caching information for loaded file systems
struct MntEntInfoCache final {
    std::vector<MntEntInfo> items;
    MntEntInfoMap mapping;
};

}  // namespace ap::file
