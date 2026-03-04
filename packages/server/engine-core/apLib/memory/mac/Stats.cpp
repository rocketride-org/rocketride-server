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

namespace ap::memory {

// Pulled from examples at:
// https://stackoverflow.com/questions/63166/how-to-determine-cpu-and-memory-consumption-from-inside-a-process
ErrorOr<Stats> stats() noexcept {
    Stats st;

    // Resident and virtual for current process
    {
        struct task_basic_info info{};
        mach_msg_type_number_t infoCount = TASK_BASIC_INFO_COUNT;
        if (task_info(mach_task_self(), TASK_BASIC_INFO,
                      _reCast<task_info_t>(&info),
                      &infoCount) == KERN_SUCCESS) {
            st.physicalMemoryUsedByProcess = info.resident_size;
            st.virtualMemoryUsedByProcess = info.virtual_size;
        }
    }

    // System wide physical total
    {
        int mib[2];
        int64_t physical_memory;
        mib[0] = CTL_HW;
        mib[1] = HW_MEMSIZE;
        auto length = sizeof(int64_t);
        sysctl(mib, 2, &physical_memory, &length, NULL, 0);
        st.physicalMemoryTotal = physical_memory;
    }

    // System wide memory usage
    {
        vm_size_t page_size;
        mach_port_t mach_port;
        mach_msg_type_number_t count;
        vm_statistics64_data_t vm_stats;

        mach_port = mach_host_self();
        count = sizeof(vm_stats) / sizeof(natural_t);
        if (KERN_SUCCESS == host_page_size(mach_port, &page_size) &&
            KERN_SUCCESS == host_statistics64(mach_port, HOST_VM_INFO,
                                              (host_info64_t)&vm_stats,
                                              &count)) {
            long long free_memory =
                (int64_t)vm_stats.free_count * (int64_t)page_size;

            long long used_memory = ((int64_t)vm_stats.active_count +
                                     (int64_t)vm_stats.inactive_count +
                                     (int64_t)vm_stats.wire_count) *
                                    (int64_t)page_size;
            st.physicalMemoryUsed = used_memory;
        }
    }

    // For system wide virtual memory usage on mac you have to hit the disk
    // (see post above), for now, not necessary
    //
    return st;
}

}  // namespace ap::memory
