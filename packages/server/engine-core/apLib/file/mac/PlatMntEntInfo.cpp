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
using namespace ap;
using namespace ap::file;

namespace {

// Mac file system defaults for obtaining mounted file system information
_const auto MntEntryPath = "_PATH_MOUNTED";
_const auto MntDevPrefix = "/dev/"_tv;
_const auto MntSysBlockRemovablePrefix = "/sys/block/"_tv;
_const auto MntSysBlockRemovablePostfix = "/removable"_tv;

}  // namespace

namespace ap::file {

// Obtain refreshed information about the mounted file systems
SharedPtr<MntEntInfoCache> refreshMounting() noexcept {
    auto result = makeShared<MntEntInfoCache>();
    // TBD remove the related functions, not used anywhere
    return result;
}

}  // namespace ap::file
