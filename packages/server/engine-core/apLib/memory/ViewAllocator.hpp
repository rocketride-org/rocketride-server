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

namespace ap::memory {

class ViewAllocatorArena {
public:
    ViewAllocatorArena(OutputData data, bool rehydrate = false) noexcept
        : m_data(data), m_rehydrate(rehydrate), m_readOnly(false) {
        reset();
    }

    ViewAllocatorArena(InputData data) noexcept
        : m_data(_constCast<uint8_t*>(data.data()), data.size()),
          m_rehydrate(true),
          m_readOnly(true) {
        reset();
    }

    ~ViewAllocatorArena() noexcept = default;
    ViewAllocatorArena(const ViewAllocatorArena&) = delete;
    ViewAllocatorArena& operator=(const ViewAllocatorArena&) = delete;

    uint8_t* allocate(size_t len) noexcept(false) {
        auto res = m_cursor.consumeSlice(len);
        if (res.size() != len)
            APERR_THROW(Ec::OutOfMemory, "View allocator of size", size(),
                        "ran out of memory for request", len);
        return res;
    }

    void deallocate(uint8_t* p, size_t len) noexcept {}

    size_t size() const noexcept { return m_data.size(); }

    size_t used() const noexcept { return m_data.size() - m_cursor.size(); }

    void reset() noexcept { m_cursor = m_data; }

    auto endRehydration() noexcept { m_rehydrate = false; }

    auto rehydrate() const noexcept { return m_rehydrate || m_readOnly; }

    InputData data(Opt<size_t> size = {}) const noexcept {
        return m_data.slice(size.value_or(used()));
    }

    friend bool operator==(const ViewAllocatorArena& a,
                           const ViewAllocatorArena& other) noexcept;

private:
    uint8_t* validate(uint8_t* p) noexcept {
        ASSERTD_MSG(&m_data.front() <= p && &m_data.back() >= p,
                    "Invalid address");
        return p;
    }

    bool m_rehydrate, m_readOnly;
    OutputData m_data, m_cursor;
};

inline bool operator==(const ViewAllocatorArena& a,
                       const ViewAllocatorArena& b) noexcept {
    return a.m_data.size() == b.m_data.size() &&
           &a.m_data.front() == &b.m_data.front();
}

template <typename T, typename RType = T>
class ViewAllocator : public ChildOf<ViewAllocatorArena>,
                      public std::allocator<T> {
public:
    using Parent = ChildOf<ViewAllocatorArena>;
    using ParentAllocator = std::allocator<T>;
    using ArenaType = typename Parent::ParentType;
    using value_type = T;
    using Parent::parent;

public:
    ViewAllocator() = delete;

    ViewAllocator(const ViewAllocator&) = default;
    ViewAllocator& operator=(const ViewAllocator&) = default;

    ViewAllocator(ArenaType& arena) noexcept : Parent(arena) {}

    template <class U, typename R = RType>
    ViewAllocator(const ViewAllocator<U, R>& allocator) noexcept
        : Parent(allocator.parent()) {}

    // When we rebind as another type, we pass along the RType, this is the
    // one type we will skip hydration for
    template <class Up>
    struct rebind {
        using other = ViewAllocator<Up, RType>;
    };

    T* allocate(size_t count) noexcept(false) {
        if constexpr (traits::IsSameTypeV<RType, T>)
            return _reCast<T*>(parent().allocate(count * sizeof(T)));
        else
            return ParentAllocator::allocate(count);
    }

    void deallocate(T* p, size_t count) noexcept {
        if constexpr (traits::IsSameTypeV<RType, T>)
            parent().deallocate(_reCast<uint8_t*>(p), count * sizeof(T));
        else
            ParentAllocator::deallocate(p, count);
    }

    template <typename U, typename... Args>
    void construct(U* p, Args&&... args) {
        if constexpr (traits::IsSameTypeV<U, RType>) {
            if (!parent().rehydrate())
                ::new ((void*)p) U(std::forward<Args>(args)...);
        } else
            ::new ((void*)p) U(std::forward<Args>(args)...);
    }

    size_t max_size() const noexcept { return parent().size() / sizeof(T); }

    template <class T1, typename R1, class U, typename R2>
    friend bool operator==(const ViewAllocator<T1, R1>& x,
                           const ViewAllocator<U, R2>& y) noexcept;

    template <class U, typename R>
    friend class ViewAllocator;
};

template <class T1, typename R1, class U, typename R2>
inline bool operator==(const ViewAllocator<T1, R1>& x,
                       const ViewAllocator<U, R2>& y) noexcept {
    return x.parent() == y.parent();
}

template <class T1, typename R1, class U, typename R2>
inline bool operator!=(const ViewAllocator<T1, R1>& x,
                       const ViewAllocator<U, R2>& y) noexcept {
    return !(x == y);
}

}  // namespace ap::memory
