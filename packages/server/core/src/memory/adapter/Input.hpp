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

#pragma once

namespace ap::memory::adapter {

template <typename BackingT, typename Enable = void>
class Input;

// Specialize for contiguous containers of pod types
template <typename BackingT>
class Input<BackingT, traits::IfContiguousPodContainer<BackingT>> {
public:
    using Traits = traits::ContainerTraits<BackingT>;
    using value_type = typename Traits::ValueType;
    static_assert(sizeof(value_type) == sizeof(uint8_t));

    Input(const BackingT &backing, Opt<file::Path> path = {}) noexcept
        : m_backing(backing), m_path(_mv(path)) {}

    uint64_t offset() const noexcept(false) { return m_offset; }

    void setOffset(uint64_t offset) const noexcept(false) {
        if (size() < offset)
            APERR_THROW(Ec::OutOfRange, "Offset", offset, " < size", size());
        m_offset = offset;
    }

    size_t read(OutputData data, Opt<size_t> min = {}) const noexcept(false) {
        auto avail = size() - offset();
        auto requested = min.value_or(data.size());
        if (avail < requested)
            APERR_THROW(Ec::Bug, "Available", avail, "is less than requested",
                        requested);
        else if (!avail)
            return 0;

        auto inData = memory::DataView{&m_backing.get().at(offset()), avail};
        auto len = data.copyConsume(inData);
        m_offset += len;
        return len;
    }

    uint64_t size() const noexcept(false) { return m_backing.get().size(); }

    bool empty() const noexcept(false) { return size() != 0; }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        return _tsb(buff, "[Input offset:", string::toHumanSize(offset()), "]");
    }

    file::Path path() const noexcept {
        if (m_path) return m_path.value();
        return {};
    }

    decltype(auto) operator*() const noexcept { return m_backing.get(); }

private:
    CRef<BackingT> m_backing;
    mutable uint64_t m_offset = {};
    Opt<file::Path> m_path;
};

}  // namespace ap::memory::adapter
