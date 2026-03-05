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

#include <engLib/eng.h>

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Return permission information
//-------------------------------------------------------------------------
ErrorOr<std::list<Text>> IServiceEndpoint::outputPermissions() noexcept {
    if (!permissionInfo.size()) return {};

    std::list<Text> outputList;
    // Finalize the permission sets`
    MONITOR(status, "Building permission sets");
    const auto permsList = permissionInfo.build();

    MONITOR(status, "Writing principals and permission sets");
    for (const auto &[key, userRecord] : permissionInfo.getUsers()) {
        auto ccode = perms::outputPermission(userRecord);
        if (ccode.hasCcode()) {
            return ccode.ccode();
        }
        if (ccode.hasValue()) {
            Text val = ccode.value();
            outputList.push_back(val);
        }
    }
    for (const auto &[key, groupRecord] : permissionInfo.getGroups()) {
        auto ccode = perms::outputPermission(groupRecord);
        if (ccode.hasCcode()) {
            return ccode.ccode();
        }
        if (ccode.hasValue()) {
            Text val = ccode.value();
            outputList.push_back(val);
        }
    }

    for (const auto &permSet : permsList) {
        ErrorOr<Text> ccode = engine::perms::outputPermission(permSet);
        if (ccode.hasCcode())
            return ccode.ccode();
        else if (ccode.hasValue()) {
            Text val = ccode.value();
            outputList.push_back(val);
        }
    }

    return outputList;
}
}  // namespace engine::store
