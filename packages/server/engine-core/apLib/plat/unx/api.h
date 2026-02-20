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
#include <sys/statvfs.h>
namespace ap::plat {

Text hostName() noexcept;
uint32_t cpuCount() noexcept;
uint32_t gpuSize() noexcept;
ErrorOr<int> systemDiskUtilization() noexcept;
ErrorOr<DiskUsage> diskUsage(const file::Path& path) noexcept;
bool isWsl1() noexcept(false);
ErrorOr<timespec> getFileAccessTime(int fd) noexcept;
Error setFileAccessTime(int fd, const timespec& atime) noexcept;
Error setFileAccessAndModificationTimes(const file::Path& path,
                                        const timeval& atime,
                                        const timeval& mtime) noexcept;
ErrorOr<timespec> getFileAccessTime(const file::Path& path) noexcept;
Error setFileAccessTime(const file::Path& path, const timespec& atime) noexcept;
TextView renderSignal(int signal) noexcept;
TextView renderSignalDescription(int signal) noexcept;
Text renderSoname(TextView libName) noexcept;

template <typename MethodT>
ErrorOr<MethodT*> dynamicBind(const file::Path& libPath, const char* methodName,
                              bool changeDir = false) noexcept;

struct Processor {
    uint32_t id = {};
    Text vendor;
    uint32_t family = {};
    uint32_t model = {};
    Text modeName;
    uint32_t stepping = {};
    uint32_t microcode = {};
    double mhz = {};
    Size cacheSize;
    uint32_t physicalId = {};
    uint32_t siblings = {};
    uint32_t coreId;
    uint32_t cores = {};
    uint32_t apicId = {};
    uint32_t initialApicId = {};
    bool fpu = {};
    bool fpuException = {};
    uint32_t cpuidLevel = {};
    bool wp = {};
    std::vector<Text> flags;
    std::vector<Text> bugs;
    double bogoMips = {};
    Text tlbSize;
    uint32_t clFlushSize = {};
    uint32_t cacheAlignment;
    std::vector<Text> powerManagement;
    std::map<Text, Text> additionalInfo;
};
ErrorOr<std::vector<Processor>> getProcessors() noexcept;

}  // namespace ap::plat
