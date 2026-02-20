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
#if !(defined(ROCKETRIDE_PLAT_MAC) && \
      (defined(__arm64__) || defined(__aarch64__)))
#include <cpuid.h>

namespace ap::plat {

std::array<uint32_t, 4> CpuInfo::cpuid(int leaf) noexcept {
    // Use __get_cpuid_count instead of __get_cpuid because the latter clears
    // the ECX register
    std::array<uint32_t, 4> ids = {};
    __get_cpuid_count(leaf, 0, &ids[0], &ids[1], &ids[2], &ids[3]);
    return ids;
}

uint32_t CpuInfo::cpuidMax() noexcept {
    // Calling __get_cpuid_max with 0x0 gets the number of the highest valid
    // function ID
    return __get_cpuid_max(0, nullptr);
}

uint32_t CpuInfo::cpuidExMax() noexcept {
    // Calling __get_cpuid_max with 0x80000000 gets the number of the highest
    // valid extended ID
    return __get_cpuid_max(0x80000000, nullptr);
}

}  // namespace ap::plat

#else

namespace ap::plat {

std::array<uint32_t, 4> CpuInfo::cpuid(int leaf) noexcept {
    std::array<uint32_t, 4> ids = {};
    return ids;
}

uint32_t CpuInfo::cpuidMax() noexcept { return 0; }

uint32_t CpuInfo::cpuidExMax() noexcept { return 0; }

}  // namespace ap::plat

#endif
