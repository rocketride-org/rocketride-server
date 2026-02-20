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

namespace ap::file {

// A mount info is what we create when mount information is requested.
// It holds the metadata for the mount such as volume type and options.
struct MntEntInfo final : public PlatMntEntInfo {
    uint64_t deviceId{};
    bool removable{};
    Text name;
    Text mountPath;
    std::vector<FsType> types;
    TextVector mountOptions;
};

// Given a file path, obtain the mounting path information for the file.
ErrorOr<MntEntInfo> getMntEntInfo(const Path& path) noexcept;

// Given a file path, obtain if the underlying mounting path is removable.
bool isOnRemovableDrive(const Path& path) noexcept;

}  // namespace ap::file
