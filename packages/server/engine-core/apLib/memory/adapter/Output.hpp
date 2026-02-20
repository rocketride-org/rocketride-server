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

template <typename BackingT, typename Enable = void>
class Output;

// Specialize for contiguous containers of pod types
template <typename BackingT>
class Output<BackingT, traits::IfContiguousPodContainer<BackingT>> {
public:
    using Traits = traits::ContainerTraits<BackingT>;
    using ElemType = typename Traits::ValueType;
    using value_type = ElemType;
    static_assert(sizeof(value_type) == sizeof(uint8_t));

    _const auto HasResize = Traits::HasResize;

    Output(BackingT& backing, Opt<file::Path> path = {}) noexcept
        : m_backing(backing), m_path(_mv(path)) {}

    void setOffset(uint64_t offset) const noexcept(false) {
        if (size() < offset)
            APERR_THROW(Ec::OutOfRange, "Offset", offset, " < size", size());
        m_offset = offset;
    }

    uint64_t offset() const noexcept(false) { return m_offset; }

    void write(InputData data) noexcept(false) {
        ASSERT(size() >= offset());
        auto avail = size() - offset();
        if constexpr (HasResize) {
            if (avail < data.size())
                m_backing.get().resize(size() + (data.size() - avail));
        } else {
            if (avail < data.size())
                APERR_THROW(Ec::InvalidParam, "No room to copy", data.size());
        }

        auto outData =
            memory::DataView{&m_backing.get().at(offset()), data.size()};
        std::memcpy(outData, data, data.size());
        m_offset += data.size();
    }

    uint64_t size() const noexcept(false) { return m_backing.get().size(); }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        return _tsb(buff, "[Output offset:", string::toHumanSize(offset()),
                    "]");
    }

    file::Path path() const noexcept {
        if (m_path) return m_path.value();
        return {};
    }

    decltype(auto) operator*() noexcept { return m_backing.get(); }

private:
    Ref<BackingT> m_backing;
    mutable uint64_t m_offset = {};
    Opt<file::Path> m_path;
};

}  // namespace ap::memory::adapter
