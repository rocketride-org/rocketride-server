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

// A snap context contains the mappings and the platform specific
// snap client
struct Context {
    Context() = default;

    // Map vol roots to snap paths
    SnapMap snaps;

    // Map mount paths to volume roots
    MountMap mounts;

    // Map snap paths to vol roots
    VolMap vols;

#if !defined(ROCKETRIDE_PLAT_MAC)
    // Platform specific client object performing the snap operations
    Opt<Client> client;
#endif

    // Snapshot info from the context may be exported out to json and
    // loaded back, this is how we share persistent snapshots across
    // engine instances
    void __toJson(json::Value& val) const noexcept;
    static Error __fromJson(Context& Ctx, const json::Value& val) noexcept;

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        return _tsbo(buff, {0, 0, '\n'}, snaps);
    }
};

}  // namespace ap::file::snap
