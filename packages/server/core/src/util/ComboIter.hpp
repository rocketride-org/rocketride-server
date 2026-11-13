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

namespace ap::util {

// Combo iter is a class that walks two containers, and optionally
// provides results to the ones that are not completed
template <typename ContainerT>
class ComboIter {
public:
    using ElementType = traits::ElemT<ContainerT>;

    ComboIter(ContainerT &lc, ContainerT &rc) noexcept
        : m_lc(lc),
          m_rc(rc),
          m_li(m_lc.get().begin()),
          m_ri(m_rc.get().begin()) {}

    ComboIter() = default;
    ComboIter(const ComboIter &) = default;
    ComboIter(ComboIter &&) = default;

    ComboIter &operator=(const ComboIter &) = default;
    ComboIter &operator=(ComboIter &&) = default;

    explicit operator bool() const noexcept {
        return m_li != m_lc.get().end() || m_ri != m_rc.get().end();
    }

    decltype(auto) operator++(int dummy) noexcept {
        auto copy = *this;
        if (m_li != m_lc.get().end()) m_li++;
        if (m_ri != m_rc.get().end()) m_ri++;
        return copy;
    }

    decltype(auto) operator++() noexcept {
        if (m_li != m_lc.get().end()) m_li++;
        if (m_ri != m_rc.get().end()) m_ri++;
        return *this;
    }

    Pair<Opt<Ref<traits::ElemT<ContainerT>>>,
         Opt<Ref<traits::ElemT<ContainerT>>>>
    explode() noexcept {
        if (m_li != m_lc.get().end() && m_ri != m_rc.get().end())
            return {*m_li, *m_ri};
        else if (m_li != m_lc.get().end())
            return {*m_li, {}};
        else if (m_ri != m_rc.get().end())
            return {{}, *m_ri};
        else
            return {};
    }

private:
    Ref<ContainerT> m_lc, m_rc;
    typename ContainerT::iterator m_li, m_ri;
};

}  // namespace ap::util
