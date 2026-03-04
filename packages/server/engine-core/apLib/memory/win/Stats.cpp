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
#include <psapi.h>

namespace ap::memory {

ErrorOr<Stats> stats() noexcept {
    Stats stats;

    // Load total virtual memory
    MEMORYSTATUSEX memInfo;
    memInfo.dwLength = sizeof(MEMORYSTATUSEX);
    GlobalMemoryStatusEx(&memInfo);
    stats.virtualMemoryTotal = memInfo.ullTotalPageFile;

    // Load virtual memory used by the system
    stats.virtualMemoryUsed =
        memInfo.ullTotalPageFile - memInfo.ullAvailPageFile;

    // Load virtual memory used by this process
    PROCESS_MEMORY_COUNTERS_EX pmc;
    GetProcessMemoryInfo(GetCurrentProcess(),
                         reinterpret_cast<PPROCESS_MEMORY_COUNTERS>(&pmc),
                         sizeof(pmc));
    stats.virtualMemoryUsedByProcess = pmc.PrivateUsage;

    // Load total physical memory
    stats.physicalMemoryTotal = memInfo.ullTotalPhys;

    // Load physical memory used by the system
    stats.physicalMemoryUsed = memInfo.ullTotalPhys - memInfo.ullAvailPhys;

    // Load physical memory used by this process
    stats.physicalMemoryUsedByProcess = pmc.WorkingSetSize;

    return stats;
}

}  // namespace ap::memory
