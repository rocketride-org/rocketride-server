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

namespace ap::file::snap {

#if ROCKETRIDE_PLAT_WIN
using Client = class VssClient;
#elif ROCKETRIDE_PLAT_LIN
using Client = class LvmClient;
#endif

// Mapping of volume paths to snapshot paths, this
// just maps the first component in a path so
// Volume{GUID} => GLOBALROOT/Device/HarddiskVolumeShadowCopy18
using SnapMap = std::map<Path::StrType, Path>;

// Mapping of snap paths to volume roots
// just maps the first component in a path so
// GLOBALROOT/Device/HarddiskVolumeShadowCopy18 => Volume{GUID}
using VolMap = std::map<Path, Path::StrType>;

// Mount point to volume guid map
// s:/ => Volume{GUID}
using MountMap = std::map<Path, Path::StrType>;

using PathMap = std::map<Path, Path>;

}  // namespace ap::file::snap
