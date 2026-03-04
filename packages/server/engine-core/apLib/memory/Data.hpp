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

template <typename DataT, typename AllocatorT>
class Data : public std::vector<DataT, AllocatorT> {
public:
    using Parent = std::vector<DataT, AllocatorT>;
    using ElemType = std::decay_t<DataT>;

    // Expected STL types
    using typename Parent::allocator_type;
    using typename Parent::const_iterator;
    using typename Parent::const_pointer;
    using typename Parent::const_reference;
    using typename Parent::const_reverse_iterator;
    using typename Parent::difference_type;
    using typename Parent::iterator;
    using typename Parent::pointer;
    using typename Parent::reference;
    using typename Parent::reverse_iterator;
    using typename Parent::size_type;
    using typename Parent::value_type;

    static_assert(std::is_same_v<traits::ValueT<allocator_type>, value_type>,
                  "Cannot mix allocator of different value types");
    static_assert(traits::IsPodV<DataT>,
                  "Only pod types allowed for data type");

    // Expose parent constructors and most parent methods
    using Parent::assign;
    using Parent::at;
    using Parent::back;
    using Parent::begin;
    using Parent::capacity;
    using Parent::cbegin;
    using Parent::cend;
    using Parent::clear;
    using Parent::data;
    using Parent::empty;
    using Parent::end;
    using Parent::front;
    using Parent::get_allocator;
    using Parent::max_size;
    using Parent::Parent;
    using Parent::rbegin;
    using Parent::rend;
    using Parent::reserve;
    using Parent::resize;
    using Parent::shrink_to_fit;
    using Parent::size;
    using Parent::swap;

    Data(const DataView<const DataT>& data,
         const allocator_type& alloc = {}) noexcept
        : Parent(alloc) {
        append(data);
    }

    Data(const DataView<DataT>& data, const allocator_type& alloc = {}) noexcept
        : Parent(alloc) {
        append(data);
    }

    Data(const value_type* const data, size_t len,
         const allocator_type& alloc = {}) noexcept
        : Parent(alloc) {
        append(data, len * sizeof(DataT));
    }

    Data(Data&& data, size_t len) noexcept : Parent(_mv(data)) { resize(len); }

    Data& operator=(const DataView<const DataT>& data) noexcept {
        clear();
        return append(data);
    }

    Data& operator=(const DataView<DataT>& data) noexcept {
        clear();
        return append(data);
    }

    template <typename T>
    bool operator==(const DataView<T>& other) const noexcept {
        return size() == other.size() &&
               std::memcmp(data(), other.data(), size()) == 0;
    }

    auto availAt(size_t offset = 0) const noexcept {
        auto len = size();
        if (offset < len) len -= offset;
        return len;
    }

    operator value_type*() noexcept {
        if (empty()) return nullptr;
        return data();
    }

    operator const value_type*() const noexcept {
        if (empty()) return nullptr;
        return data();
    }

    explicit operator bool() const noexcept { return empty() == false; }

    uint32_t byteSize32() const noexcept { return byteSize<uint32_t>(); }

    template <typename SizeType = size_t>
    SizeType byteSize() const noexcept {
        return _nc<SizeType>(size() * (sizeof(value_type) / sizeof(uint8_t)));
    }

    template <typename SizeType = size_t>
    SizeType byteSizeAt(SizeType byteOffset) const noexcept {
        auto size = byteSize<SizeType>();
        if (byteOffset > size) return 0;
        return size - byteOffset;
    }

    template <typename SizeType = size_t>
    SizeType sizeAs() const noexcept {
        return _nc<SizeType>(size());
    }

    uint32_t size32() const noexcept { return sizeAs<uint32_t>(); }

    template <typename SizeType = size_t>
    SizeType sizeAt(SizeType offset) const noexcept {
        if (offset > size()) return 0;
        return size() - offset;
    }

    auto growTo(size_t newSize) noexcept {
        if (size() < newSize) resize(newSize);
    }

    value_type& operator*() noexcept { return data(); }

    template <typename T = value_type,
              typename = std::enable_if_t<std::is_standard_layout_v<T> ||
                                          std::is_void_v<T>>>
    decltype(auto) append(const T* data, size_t length = sizeof(T)) noexcept {
        if (!length) return *this;

        auto oldPos = size();
        resize(size() + length);
        std::memcpy(&at(oldPos), _reCast<const void*>(data), length);
        return *this;
    }

    decltype(auto) append(const Data& data) noexcept {
        return append(data.data(), data.size());
    }

    template <typename T = value_type,
              typename = std::enable_if_t<std::is_standard_layout_v<T> ||
                                          std::is_void_v<T>>>
    decltype(auto) append(const void* data,
                          size_t length = sizeof(T)) noexcept {
        return append(_reCast<const uint8_t*>(data), length);
    }

    decltype(auto) append(DataView<const DataT> data) noexcept {
        return append(data, data.size() * sizeof(DataT));
    }

    decltype(auto) append(DataView<DataT> data) noexcept {
        return append(data, data.size() * sizeof(DataT));
    }

    template <typename T = value_type,
              typename = std::enable_if_t<std::is_standard_layout_v<T> ||
                                          std::is_void_v<T>>>
    decltype(auto) castAt(size_t offset,
                          size_t expectedLength = sizeof(T)) noexcept {
        ASSERT(availAt(offset) >= expectedLength);
        return _reCast<T*>(&at(offset));
    }

    template <typename T = value_type,
              typename = std::enable_if_t<std::is_standard_layout_v<T> ||
                                          std::is_void_v<T>>>
    decltype(auto) castAt(size_t offset,
                          size_t expectedLength = sizeof(T)) const noexcept {
        ASSERT(availAt(offset) >= expectedLength);
        return _reCast<const T*>(&at(offset));
    }

    template <typename T = value_type,
              typename = std::enable_if_t<std::is_standard_layout_v<T> ||
                                          std::is_void_v<T>>>
    T* tryCastAt(size_t offset, size_t expectedLength = sizeof(T)) noexcept {
        if (availAt(offset) < expectedLength) return nullptr;
        return _reCast<T*>(&at(offset));
    }

    template <typename T = value_type,
              typename = std::enable_if_t<std::is_standard_layout_v<T> ||
                                          std::is_void_v<T>>>
    const T* tryCastAt(size_t offset,
                       size_t expectedLength = sizeof(T)) const noexcept {
        if (availAt(offset) < expectedLength) return nullptr;
        return _reCast<const T*>(&at(offset));
    }

    template <typename T = value_type,
              typename = std::enable_if_t<std::is_standard_layout_v<T> ||
                                          std::is_void_v<T>>>
    decltype(auto) cast(size_t expectedLength = 1) noexcept {
        return castAt<T>(0, expectedLength);
    }

    template <typename T = value_type,
              typename = std::enable_if_t<std::is_standard_layout_v<T> ||
                                          std::is_void_v<T>>>
    decltype(auto) cast(size_t expectedLength = 1) const noexcept {
        return castAt<const T>(0, expectedLength);
    }

    template <typename T = value_type,
              typename = std::enable_if_t<std::is_class_v<T>>>
    const T* operator->() const noexcept {
        return castAt<const T>(0);
    }

    template <typename T = value_type,
              typename = std::enable_if_t<std::is_class_v<T>>>
    T* operator->() noexcept {
        return castAt<const T>(0);
    }

    auto copyAt(size_t offset, const void* data, size_t length) noexcept {
        std::memcpy(castAt(offset, length), data, length);
    }

    auto copy(const void* data, size_t length) noexcept {
        copyAt(0, data, length);
    }

    template <typename T, typename A>
    auto copyAt(size_t offset, const Data<T, A>& data,
                Opt<size_t> length = {}) noexcept {
        const auto requested = length.value_or(data.size());
        std::memcpy(castAt(offset, requested), data.cast(requested), requested);
    }

    template <typename T>
    auto copyAt(size_t offset, DataView<const T> data) noexcept {
        copyAt(offset, data, data.size());
    }

    template <typename T>
    auto copy(DataView<const T> data) noexcept {
        copyAt(0, data);
    }

    template <typename T>
    auto copyAt(size_t offset, DataView<T> data) noexcept {
        copyAt(offset, data, data.size());
    }

    template <typename T>
    auto copy(DataView<T> data) noexcept {
        copyAt(0, data);
    }

    operator string::StrView<ElemType>() const noexcept {
        return {data(), size()};
    }

    template <typename T = value_type>
    DataView<const T> sliceAt(size_t offset = 0,
                              Opt<size_t> length = {}) const noexcept {
        auto avail = sizeAt(offset);
        auto requested = length.value_or(avail);
        if (requested > avail) requested = avail;
        if (requested) return DataView{&at(offset), requested};
        return {};
    }

    template <typename T = value_type>
    auto slice(Opt<size_t> length = {}) const noexcept {
        return sliceAt(0, length);
    }

    template <typename T = value_type>
    DataView<T> sliceAt(size_t offset = 0, Opt<size_t> length = {}) noexcept {
        auto avail = sizeAt(offset);
        auto requested = length.value_or(avail);
        if (requested > avail) requested = avail;
        if (requested) return DataView{&at(offset), requested};
        return {};
    }

    template <typename T = value_type>
    auto slice(Opt<size_t> length = {}) noexcept {
        return sliceAt(0, length);
    }

    template <typename T = value_type>
    memory::DataView<T> toView() noexcept {
        return {data(), size()};
    }

    template <typename T = value_type>
    memory::DataView<const T> toView() const noexcept {
        return {data(), size()};
    }

    operator memory::DataView<DataT>() noexcept { return toView(); }

    operator memory::DataView<const DataT>() const noexcept { return toView(); }

    template <typename ChrT = Utf8Chr,
              typename TraitsT = std::char_traits<ChrT>>
    string::StrView<ChrT, TraitsT> toTextView(
        size_t offset = 0, Opt<size_t> length = {}) const noexcept {
        static_assert(
            sizeof(value_type) == sizeof(ChrT),
            "Cannot cast to TextView with fundamentally different type size");
        auto slice = sliceAt(offset, length);
        return string::StrView<ChrT, TraitsT>(
            _reCast<const ChrT*>(slice.data()), slice.size());
    }

    template <typename Buffer>
    decltype(auto) __toString(Buffer& buff) const noexcept {
        buff << toView();
    }
};

}  // namespace ap::memory
