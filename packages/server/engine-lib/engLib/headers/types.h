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

namespace engine {

// Our native types - engine::store uses these a lot for compat with porting
// from the FPI engine
using Bool = int32_t;
using Byte = unsigned char;
using Word = uint16_t;
using Dword = uint32_t;
using Qword = uint64_t;

// This is what we expose to the app for a logical components stat structure
// its a subset of file::Stat but it is intended to be source agnostic
struct ComponentInfo {
    size_t size{};
    size_t storeSize{};

    time::SystemStamp modifyTime;
    time::SystemStamp accessTime;
    std::optional<time::SystemStamp> changeTime;
    time::SystemStamp createTime;
};

// A more generic stat info for service-level fs-type apis
struct StatInfo {
    bool isDir{};
    size_t size{};
    Text id;
    time::SystemStamp modifyTime;

    // Allow for access to os-/service-specific stat infos
    json::Value internal;

    auto __jsonSchema() const noexcept {
        return json::makeSchema(isDir, "isDir", size, "size", id, "id",
                                modifyTime, "modifyTime", internal, "internal");
    }
};

// A basic dir entry used in service list apis
struct DirEntry {
    file::Path path;
    StatInfo info;

    template <typename Buffer>
    auto __toString(Buffer &out) const noexcept {
        _tsb(out, path, info.isDir ? "[D]"_t : _ts("[F] - ", Size(info.size)));
    }
};

// This is the scope operator for lambda functions - all variables are
// included by reference
#define localfcn [&]

}  // namespace engine
