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

Text hostName() noexcept;
uint32_t cpuCount() noexcept;
uint32_t gpuSize() noexcept;
ErrorOr<Text> osVersion() noexcept;
ErrorOr<int> systemDiskUtilization(bool forceRefresh = false) noexcept;
ErrorOr<DiskUsage> diskUsage(const file::Path& path) noexcept;
ErrorOr<int> diskUtilization(const file::Path& path,
                             bool forceRefresh = false) noexcept;
const SYSTEM_INFO& systemInfo() noexcept;
TextView renderSignal(int signal) noexcept;
TextView renderSignalDescription(int signal) noexcept;
TextView renderConsoleEvent(DWORD eventType) noexcept;
BOOL WINAPI consoleEventHandler(DWORD eventType) noexcept;
template <typename HandleType = wil::unique_handle>
ErrorOr<HandleType> duplicateHandle(
    HANDLE handle, HANDLE hTargetProcess = ::GetCurrentProcess()) noexcept;
Error setFileAccessTime(const file::Path& path, const FILETIME& atime) noexcept;
ErrorOr<IShellLinkPtr> loadShortcut(const file::Path& path) noexcept;
bool isShortcut(const file::Path& path) noexcept;
ErrorOr<file::Path> getShortcutTarget(const file::Path& path) noexcept;
Error createShortcut(const file::Path& path, const file::Path& target) noexcept;
ErrorOr<file::Path> getModulePath(const Text& moduleName) noexcept;

struct ProcessorIdentifier {
    Text architecture;
    uint32_t family = {};
    uint32_t model = {};
    uint32_t stepping = {};
    Text vendor;
};
ErrorOr<ProcessorIdentifier> processorIdentifier() noexcept;

}  // namespace ap::plat
