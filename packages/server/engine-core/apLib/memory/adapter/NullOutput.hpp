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

namespace ap::memory::adapter {

struct NullOutput {};

// Specialize for null backing
template <typename BackingT>
class Output<BackingT, ap::traits::IfSameType<BackingT, NullOutput>> {
public:
    using Traits = traits::ContainerTraits<Buffer>;
    using ElemType = uint8_t;
    using value_type = uint8_t;

    Output() = default;

    Output(const file::Path &path) : m_path{path} {}

    uint64_t offset() const noexcept(false) { return m_offset; }

    void setOffset(uint64_t offset) const noexcept(false) { m_offset = offset; }

    void write(InputData data) noexcept(false) {
        m_length += data.size();
        m_offset += data.size();
    }

    uint64_t size() const noexcept(false) { return m_length; }

    file::Path path() const noexcept { return {}; }

protected:
    file::Path m_path;
    uint64_t m_length = {};
    mutable size_t m_offset = {};
};

inline Output<NullOutput> makeNullOutput(Opt<file::Path> path = {}) noexcept {
    if (path) return Output<NullOutput>{_mvOpt(path)};
    return Output<NullOutput>{};
}

}  // namespace ap::memory::adapter
