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

inline void __transform(const file::StatInfo& fsInfo,
                        ComponentInfo& info) noexcept {
    info.modifyTime = fsInfo.modifyTime;
    info.accessTime = fsInfo.accessTime;
    info.changeTime = fsInfo.changeTime;
    info.createTime = fsInfo.createTime;
    info.storeSize = fsInfo.sizeOnDisk;
    info.size = fsInfo.size;
}

// Convert fs info to and from service info
inline auto __transform(const file::StatInfo& fs, StatInfo& prov) noexcept {
    prov.internal = _tj(fs);
    prov.isDir = fs.isDir;
    prov.size = fs.size;
    prov.id = _tso(Format::HEX, fs.volumeId, ":", fs.inode);
}

inline auto __transform(const StatInfo& prov, file::StatInfo& fs) noexcept {
    fs = _fj<file::StatInfo>(prov.internal);
}

}  // namespace engine
