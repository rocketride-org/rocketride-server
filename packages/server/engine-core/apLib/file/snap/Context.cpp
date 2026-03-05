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

#include <apLib/ap.h>

namespace ap::file::snap {

void Context::__toJson(json::Value &val) const noexcept {
    val = json::objectValue;
    for (auto &[vol, snap] : snaps) val[vol] = _tj(snap);
}

Error Context::__fromJson(Context &ctx, const json::Value &val) noexcept {
    if (!val.isObject())
        return APERRL(Snap, Ec::InvalidJson, "Expected object", val);

    for (auto &&vol : val.keys()) {
        auto &snap = ctx.snaps[vol];
        if (auto ccode = val.lookupAssign(vol, snap)) return ccode;
        if (!snap) return APERRL(Snap, Ec::InvalidJson, "Empty mapping", vol);
    }

    return buildMaps(ctx.snaps, ctx.vols, ctx.mounts);
}

}  // namespace ap::file::snap
