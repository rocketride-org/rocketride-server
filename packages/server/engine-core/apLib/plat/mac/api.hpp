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

namespace ap::plat {

inline ErrorOr<Text> osVersion() noexcept {
    char osProductVersion[256];
    size_t length = sizeof(osProductVersion);
    if (::sysctlbyname("kern.osproductversion", osProductVersion, &length,
                       nullptr, 0) != 0)
        return APERR(errno, "sysctlbyname failed");

    return _fmt("OSX {}", _reCast<const char*>(osProductVersion));
}

inline std::vector<file::Path> getModulePaths() noexcept {
    std::vector<file::Path> modulePaths;
    uint32_t moduleIndex = 0;
    // The list of loaded modules may change while this function is executing
    // Just loop until we get null
    while (auto path = _dyld_get_image_name(moduleIndex++)) {
        modulePaths.push_back(path);
    }
    return modulePaths;
}

inline uint32_t macCPUCount() noexcept {
    uint32_t nCPUCores = 0;
    size_t size = sizeof(nCPUCores);

    // Use sysctl to get the number of physical CPU cores
    if (::sysctlbyname("hw.physicalcpu", &nCPUCores, &size, nullptr, 0) != 0) {
        // If the query fails, return 0 as a fallback
        return 0;
    }
    return nCPUCores;
}

inline uint32_t macGPUSize() noexcept {
    const char* cmd = R"(
        [[ $(sysctl -n machdep.cpu.brand_string) == *"Apple"* ]] && system_profiler SPHardwareDataType | grep "Memory" | awk '{print $2, $3}' || system_profiler SPDisplaysDataType | awk '/Chipset Model:/ {skipIntel = ($0 ~ /Intel/ ? 1 : 0)} /VRAM/ && !skipIntel {for (i = 1; i <= NF; i++) if ($i == "VRAM") {vram = $(i+2); unit = $(i+3); print vram, unit; exit}}'
    )";

    FILE* pipe = popen(cmd, "r");
    if (!pipe) {
        return 0;  // Command execution failed
    }

    char buffer[256];
    uint32_t gpuMemoryMB = 0;

    // Read the command output
    if (fgets(buffer, sizeof(buffer), pipe)) {
        std::string output(buffer);
        size_t posMB = output.find("MB");
        size_t posGB = output.find("GB");

        try {
            if (posMB != std::string::npos) {
                // Extract MB value
                gpuMemoryMB = std::stoi(output.substr(0, posMB));
            } else if (posGB != std::string::npos) {
                // Extract GB value and convert to MB
                gpuMemoryMB = std::stoi(output.substr(0, posGB)) * 1024;
            }
        } catch (...) {
            gpuMemoryMB = 0;  // Fallback to 0 if parsing fails
        }
    }

    pclose(pipe);
    return gpuMemoryMB;
}

// Render the versioned soname of a given library
inline Text renderSoname(TextView libName, int version) noexcept {
    // e.g. libsmbclient.0.dylib
    return _fmt("{}.{}.{}", libName, version, LibraryExtension);
}

}  // namespace ap::plat