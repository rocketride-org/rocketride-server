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
#include <intrin.h>

namespace ap::plat {

std::array<uint32_t, 4> CpuInfo::cpuid(int leaf) noexcept {
    // Use __cpuidex instead of __cpuid because the latter clears the ECX
    // register
    std::array<int, 4> ids;
    __cpuidex(ids.data(), leaf, 0);

    std::array<uint32_t, 4> res = {};
    for (size_t i = {}; i < ids.size(); ++i) {
        res[i] = _cast<uint32_t>(ids[i]);
    }
    return res;
}

uint32_t CpuInfo::cpuidMax() noexcept {
    // Calling __cpuid with 0x0 as the function_id argument gets the number of
    // the highest valid function ID
    std::array<int, 4> ids;
    __cpuid(ids.data(), 0);
    return _cast<uint32_t>(ids[0]);
}

uint32_t CpuInfo::cpuidExMax() noexcept {
    // Calling __cpuid with 0x80000000 as the function_id argument gets the
    // number of the highest valid extended ID
    std::array<int, 4> ids;
    __cpuid(ids.data(), 0x80000000);
    return _cast<uint32_t>(ids[0]);
}

}  // namespace ap::plat