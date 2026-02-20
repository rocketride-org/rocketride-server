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

namespace ap::async::work {

class Group final {
public:
    Group() = default;

    Group(Group&& grp) noexcept : m_items(_mv(grp.m_items)) {}

    Group& operator=(Group&& grp) noexcept {
        if (this == &grp) return *this;
        m_items = _mv(grp.m_items);
        return *this;
    }

    template <typename... ItemsT>
    Group(ItemsT&&... items) noexcept {
        add(_mv(items)...);
    }

    Group(Item&& item) noexcept { add(_mv(item)); }

    ~Group() noexcept { waitForAll(true); }

    template <typename... ItemsT>
    Group& add(ItemsT&&... items) noexcept {
        auto guard = m_lock.acquire();
        ([&](auto& i) noexcept { m_items.emplace_back(i.detach()); }(items),
         ...);
        return *this;
    }

    decltype(auto) operator<<(Item&& item) noexcept { return add(_mv(item)); }

    auto size() const noexcept {
        auto guard = m_lock.acquire();
        return m_items.size();
    }

    auto join() noexcept { return waitForAll(false); }

    auto cancel() noexcept {
        auto guard = m_lock.acquire();
        for (auto& item : m_items) item->cancel();
    }

    auto stop() noexcept { return waitForAll(true); }

    auto executing(bool includePending = true, bool any = true) const noexcept {
        auto guard = m_lock.acquire();
        size_t count = 0;
        for (auto& task : m_items) {
            count += task->executing(includePending);
            if (count && any) return count;
        }
        return count;
    }

    explicit operator bool() const noexcept {
        auto guard = m_lock.acquire();
        return _anyOf(m_items,
                      [&](auto& item) { return item->executing(true); });
    }

    auto begin() noexcept { return m_items.begin(); }
    auto end() noexcept { return m_items.end(); }

    auto rbegin() noexcept { return m_items.rbegin(); }
    auto rend() noexcept { return m_items.rend(); }

    auto lock() const noexcept { return m_lock.acquire(); }

protected:
    Error waitForAll(bool cancelFirst) noexcept {
        if (cancelFirst) cancel();
        Error ccode;
        for (auto item : m_items) ccode = item->join() || ccode;
        m_items.clear();
        return ccode;
    }

    mutable async::MutexLock m_lock;
    std::vector<ItemCtxPtr> m_items;
};

}  // namespace ap::async::work
