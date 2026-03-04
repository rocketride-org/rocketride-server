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
#include "sys/types.h"
#include "sys/sysinfo.h"
#include "stdlib.h"
#include "stdio.h"
#include "string.h"

// This function extracts the kb value from the two primary
// memory keys we use for stats, VMRss, VmSize, they are
// expected to be in the form:
// 	VmRSS:	   10112 kB
template <size_t MemoryUnit>
static size_t loadMemoryKey(StackText &status, TextView key) noexcept {
    static auto statusPath = file::realpath("/proc/self/status");
    if (status.empty()) {
        status.resize(1024);
        if (!file::fetch(statusPath, status)) {
            status.clear();
            return 0;
        }
    }

    auto pos = status.find(key);
    if (pos == string::npos) return 0;

    pos = status.find_first_of("0123456789", pos + key.size());
    if (pos == string::npos) return 0;

    auto end = status.find("kB", pos);
    if (end == string::npos) return 0;

    return _fs<size_t>(TextView{&status.at(pos), end - pos}) * MemoryUnit;
}

namespace ap::memory {

ErrorOr<Stats> stats() noexcept {
    Stats stats;

    struct sysinfo memInfo = {};
    sysinfo(&memInfo);

    // Use stack text here to avoid heap usage
    StackTextArena arena;
    StackText status(arena);

    stats.virtualMemoryTotal = memInfo.totalram;
    stats.virtualMemoryUsed = memInfo.totalram - memInfo.freeram;
    stats.virtualMemoryUsedByProcess =
        loadMemoryKey<Size::kKilobyte>(status, "VmSize:");
    stats.physicalMemoryTotal = memInfo.totalram;

    long long physMemUsed = memInfo.totalram - memInfo.freeram;
    physMemUsed *= memInfo.mem_unit;
    stats.physicalMemoryUsed = physMemUsed;

    stats.physicalMemoryUsedByProcess =
        loadMemoryKey<Size::kKilobyte>(status, "VmRSS:");

    return stats;
}

}  // namespace ap::memory
