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

// Specialize for file::Stream
template <typename StreamT>
class Input<file::stream::Stream<StreamT>, AlwaysT> {
public:
    using BackingT = file::stream::Stream<StreamT>;

    Input(const BackingT &backing, Opt<file::Path> path = {}) noexcept
        : m_backing(backing), m_path(_mv(path)) {}

    void setOffset(uint64_t offset) const noexcept(false) {
        m_backing.get().setOffset(offset);
    }

    uint64_t offset() const noexcept(false) { return m_backing.get().offset(); }

    size_t read(OutputData data, Opt<size_t> min = {}) const noexcept(false) {
        auto amount = *m_backing.get().read(data);
        if (amount < min.value_or(data.size()))
            APERR_THROW(Ec::Read, "Available data is < min requested");
        return amount;
    }

    uint64_t size() const noexcept(false) {
        return _cast<uint64_t>(m_backing.get().size());
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        return _tsb(buff,
                    "[Input FileStream offset:", string::toHumanSize(offset()),
                    "]");
    }

    file::Path path() const noexcept {
        if (m_path) return m_path.value();
        return m_backing.get().path();
    }

    decltype(auto) operator*() const noexcept { return m_backing.get(); }

private:
    CRef<BackingT> m_backing;
    Opt<file::Path> m_path;
};

template <typename StreamT>
class Output<file::stream::Stream<StreamT>, AlwaysT> {
public:
    using BackingT = file::stream::Stream<StreamT>;

    Output(BackingT &backing, Opt<file::Path> path = {}) noexcept
        : m_backing(backing), m_path(_mv(path)) {}

    uint64_t offset() const noexcept(false) { return m_backing.get().offset(); }

    void setOffset(uint64_t offset) const noexcept(false) {
        m_backing.get().setOffset(offset);
    }

    void write(InputData data) const noexcept(false) {
        *m_backing.get().write(data);
    }

    uint64_t size() const noexcept(false) {
        return _cast<uint64_t>(m_backing.get().size());
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        return _tsb(buff,
                    "[Output FileStream offset:", string::toHumanSize(offset()),
                    "]");
    }

    file::Path path() const noexcept {
        if (m_path) return m_path.value();
        return m_backing.get().path();
    }

    decltype(auto) operator*() noexcept { return m_backing.get(); }

private:
    Ref<BackingT> m_backing;
    Opt<file::Path> m_path;
};

}  // namespace ap::memory::adapter
