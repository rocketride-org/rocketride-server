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

using namespace ap::file;

namespace {

_const auto MountBufferLength{1024_b};

// Obtain removable drive information given a path.
ErrorOr<bool> getMountInfo(const Path& path, wchar_t* const buffer,
                           size_t bufferLength) noexcept {
    if (GetVolumePathNameW(path.str(), buffer, _cast<DWORD>(bufferLength)) ==
        0) {
        auto result = APERR(::GetLastError(), "Failed to obtain volume name");
        LOG(File, result, path, bufferLength);
        return result;
    }

    bool isRemovable = {};
    const auto driveType = GetDriveTypeW(buffer);
    switch (driveType) {
        case DRIVE_UNKNOWN:
        case DRIVE_NO_ROOT_DIR:
        case DRIVE_FIXED:
        case DRIVE_RAMDISK:
            isRemovable = false;
            break;

        case DRIVE_REMOVABLE:
        case DRIVE_REMOTE:
        case DRIVE_CDROM:
            isRemovable = true;
            break;
    }

    // If we still haven't detected a removable drive, check hotplug info
    if (!isRemovable) {
        // Setup the drive name
        Text driveName;

        driveName = "\\\\.\\";
        driveName += path.at(0).substr(0, 2);

        // Open device handle
        HANDLE hDevice = CreateFileW(driveName, 0, 0, 0, OPEN_EXISTING,
                                     FILE_FLAG_NO_BUFFERING, 0);

        // If we opened the device...
        if (hDevice != INVALID_HANDLE_VALUE) {
            DWORD bytesReturned = 0;
            STORAGE_HOTPLUG_INFO hotPlugInfo = {0};

            // Get device hot plug info
            BOOL bResult = DeviceIoControl(
                hDevice, IOCTL_STORAGE_GET_HOTPLUG_INFO, 0, 0, &hotPlugInfo,
                sizeof(hotPlugInfo), &bytesReturned, nullptr);

            // Close device handle
            CloseHandle(hDevice);

            // Failed to get device info, this can happen if the drive letter is
            // not a disk, but a volume, as in a dynamic disk case, safe to
            // assume not hot pluggable if this fails
            if (bResult) {
                // Set based on the status returned and done
                isRemovable =
                    (hotPlugInfo.MediaRemovable || hotPlugInfo.DeviceHotplug);
            }
        }
    }

    LOG(File, "Mount information:", path, buffer, "Drive type:", driveType,
        "Removable:", isRemovable);
    return isRemovable;
}
}  // namespace

namespace ap::file {

// Returns drive information given a path.
ErrorOr<MntEntInfo> getMntEntInfo(const Path& path) noexcept {
    StackUtf16 buffer;
    buffer.reserve(MountBufferLength);
    auto info = getMountInfo(path, buffer.data(), buffer.capacity());
    if (info.hasCcode()) return info.check();

    MntEntInfo result;
    result.removable = info.value();
    result.name = buffer;
    result.mountPath = result.name;
    result.types.push_back(FsType::Unknown);

    return result;
}

// Returns true if path is on a removable drive.
bool isOnRemovableDrive(const Path& path) noexcept {
    if (path.isUnc()) return false;
    StackUtf16 buffer;
    buffer.reserve(MountBufferLength);
    auto info = getMountInfo(path, buffer.data(), buffer.capacity());
    if (info.hasCcode()) return false;
    return info.value();
}

}  // namespace ap::file
