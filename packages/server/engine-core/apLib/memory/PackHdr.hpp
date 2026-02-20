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

namespace ap::memory {

_const auto PackSig = makeId("ApPack");

#pragma pack(push, 1)
// Pack header is whats used to marshal data in ap, its very simple but
// gives us what we need when reading data in
struct PackHdr final {
    // Allow use as a pod type
    using PodType = std::true_type;

    PackHdr() = default;

    PackHdr(uint64_t _size) noexcept : size(_size) {}

    uint64_t sig = PackSig;

    // Size may be a count if whats being packed is not itself a pod
    // container
    uint64_t size = {};

    Error __validate() const noexcept {
        if (sig != PackSig)
            return APERR(Ec::PackInvalidSig, "Invalid pack signature",
                         idName(sig), "expected", idName(PackSig));
        return {};
    }
};
#pragma pack(pop)

}  // namespace ap::memory