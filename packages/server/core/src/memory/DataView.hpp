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
#include <string>
#include <stdint.h>
namespace ap::memory {

// A data view is just like a string view in that it itself doesn't
// own the data its representing, it just proxies it along.
template <typename DataT>
class DataView {
public:
    using DataType = DataT;
    using ElemType = std::decay_t<DataT>;
    using value_type = DataT;

    static_assert(traits::IsPodV<DataT>, "Only pod types allow for data type");

    _const auto IsConst = std::is_const_v<DataT>;

    DataView() = default;

    DataView(const DataView &) = default;

    DataView(DataView &&data) noexcept
        : m_data(_exch(data.m_data, nullptr)), m_size(_exch(data.m_size, 0)) {}

    DataView &operator=(const DataView &data) noexcept {
        if (this == &data) return *this;

        m_data = data.m_data;
        m_size = data.m_size;
        return *this;
    }

    DataView &operator=(DataView &&data) noexcept {
        if (this == &data) return *this;

        m_data = _exch(data.m_data, nullptr);
        m_size = _exch(data.m_size, 0);
        return *this;
    }

    DataView(DataType *data, size_t size) noexcept
        : m_data(data), m_size(size) {}

    template <typename AllocatorType>
    DataView(Data<DataType, AllocatorType> &data) noexcept {
        if (!data.empty()) {
            m_data = data.data();
            m_size = data.size();
        }
    }

    template <typename Iter>
    DataView(Iter beg, Iter end) noexcept {
        m_size = std::distance(beg, end);
        if (m_size) m_data = _reCast<DataT *>(&(*beg));
    }

    // Construct from immutable container
    template <typename T, typename = std::enable_if_t<traits::HasValueTypeV<T>>>
    DataView(const T &data, Opt<size_t> size = {}) noexcept {
        static_assert(
            sizeof(DataT) == sizeof(typename T::value_type),
            "Cannot construct view from fundamentally different type sizes");
        if (!data.empty()) m_data = _reCast<DataT *>(&data.front());
        m_size = size.value_or<size_t>(data.size());
        ASSERT(m_size <= data.size());
    }

    // Construct from mutable container
    template <typename T, typename = std::enable_if_t<traits::HasValueTypeV<T>>>
    DataView(T &data, Opt<size_t> size = {}) noexcept {
        static_assert(
            sizeof(DataT) == sizeof(typename T::value_type),
            "Cannot construct view from fundamentally different type sizes");
        if (!data.empty()) m_data = _reCast<DataT *>(&data.front());
        m_size = size.value_or<size_t>(data.size());
    }

    // Construct from C-style array
    template <size_t N, typename T>
    DataView(T (&data)[N]) noexcept {
        static_assert(
            sizeof(DataT) == sizeof(T),
            "Cannot construct view from fundamentally different type sizes");
        m_data = _reCast<DataT *>(&data[0]);
        m_size = N;
    }

    template <typename T, typename = std::enable_if_t<std::is_void_v<T>>>
    DataView(T *data, size_t size) noexcept {
        ASSERT(data);
        m_data = _reCast<DataType *>(data);
        m_size = size;
    }

    decltype(auto) at(size_t offset = 0, size_t expectedLength = 1) noexcept {
        ASSERT_MSG(offset < m_size || (offset == m_size && expectedLength == 0),
                   "Attempt to access data view at invalid offset:", offset,
                   "Buffer size:", m_size);
        ASSERT_MSG(
            offset + expectedLength <= m_size,
            "Attempt to request more data view then is available at offset:",
            offset, "Expected size:", expectedLength, "Buffer size:", m_size);
        return *(m_data + offset);
    }

    decltype(auto) at(size_t offset = 0,
                      size_t expectedLength = 1) const noexcept {
        ASSERT_MSG(offset < m_size || (offset == m_size && expectedLength == 0),
                   "Attempt to access data view at invalid offset:", offset,
                   "Buffer size:", m_size);
        ASSERT_MSG(
            offset + expectedLength <= m_size,
            "Attempt to request more data view then is available at offset:",
            offset, "Expected size:", expectedLength, "Buffer size:", m_size);
        return *(m_data + offset);
    }

    template <typename SizeType = size_t>
    SizeType sizeAs() const noexcept {
        return _nc<SizeType>(m_size);
    }

    size_t size() const noexcept { return sizeAs<size_t>(); }

    uint32_t byteSize32() const noexcept { return byteSize<uint32_t>(); }

    uint32_t size32() const noexcept { return sizeAs<uint32_t>(); }

    template <typename SizeType = size_t>
    SizeType byteSize() const noexcept {
        return _nc<SizeType>(m_size * (sizeof(DataType) / sizeof(uint8_t)));
    }

    template <typename SizeType = size_t>
    SizeType sizeAt(SizeType offset) const noexcept {
        if (offset > m_size) return _nc<SizeType>(0);
        return _nc<SizeType>(m_size - offset);
    }

    template <typename SizeType = size_t>
    SizeType size(size_t desiredSize) const noexcept {
        return std::min(sizeAs<SizeType>(), _nc<SizeType>(desiredSize));
    }

    template <typename SizeType = size_t>
    SizeType sizeAt(size_t offset, size_t desiredSize) const noexcept {
        return std::min(sizeAt<SizeType>(offset), _nc<SizeType>(desiredSize));
    }

    bool empty() const noexcept { return size() == 0; }

    bool operator<(const DataView &rhs) const noexcept {
        return std::memcmp(m_data, rhs.m_data, std::min(size(), rhs.size())) <
               0;
    }

    template <typename T = DataType>
    DataView<const T> sliceAt(size_t offset = 0,
                              Opt<size_t> size = {}) const noexcept {
        auto avail = sizeAt(offset);
        auto requested = size.value_or(avail);
        if (requested > avail) requested = avail;
        if (requested) return DataView{&at(offset), requested};
        return {};
    }

    template <typename T = DataType>
    auto slice(Opt<size_t> size = {}) const noexcept {
        return sliceAt(0, size);
    }

    template <typename T = DataType>
    DataView<T> sliceAt(size_t offset = 0, Opt<size_t> size = {}) noexcept {
        auto avail = sizeAt(offset);
        auto requested = size.value_or(avail);
        if (requested > avail) requested = avail;
        if (requested) return DataView{&at(offset), requested};
        return {};
    }

    template <typename T = DataType>
    auto slice(Opt<size_t> size = {}) noexcept {
        return sliceAt(0, size);
    }

    template <typename T = DataType>
    size_t copyAt(size_t offset, const Data<T> &other) noexcept {
        static_assert(
            sizeof(DataT) == sizeof(T),
            "Cannot copy view from fundamentally different type sizes");
        auto len = size(other.size());
        if (!len) return 0;

        std::memcpy(castAt(offset, len), other.cast(len), len);
        return len;
    }

    template <typename T = DataType>
    size_t copy(const Data<T> &other) noexcept {
        return copyAt(0, other);
    }

    template <typename T = DataType>
    size_t copyConsumeAt(size_t offset, const Data<T> &other) noexcept {
        static_assert(
            sizeof(DataT) == sizeof(T),
            "Cannot copy view from fundamentally different type sizes");
        auto len = sizeAt(offset, other.size());
        if (!len) return 0;

        std::memcpy(castAt(offset, len), other.cast(len), len);

        auto remaining = other.slice(len);
        std::advance(*this, len);
        return len;
    }

    template <typename T = DataType>
    auto copyConsume(const Data<T> &other) noexcept {
        return copyConsumeAt(0, other);
    }

    template <typename T = DataType>
    size_t copyAt(size_t offset, DataView<const T> other) noexcept {
        static_assert(
            sizeof(DataT) == sizeof(T),
            "Cannot copy view from fundamentally different type sizes");
        auto len = sizeAt(offset, other.size());
        if (!len) return 0;

        std::memcpy(castAt(offset, len), other.cast(len), len);
        return len;
    }

    template <typename T = DataType>
    size_t copy(DataView<const T> other) noexcept {
        return copyAt(0, other);
    }

    template <typename T = DataType>
    size_t copyAt(size_t offset, DataView<T> other) noexcept {
        static_assert(
            sizeof(DataT) == sizeof(T),
            "Cannot copy view from fundamentally different type sizes");
        auto len = sizeAt(offset, other.size());
        if (!len) return 0;

        std::memcpy(castAt(offset, len), other.cast(len), len);
        return len;
    }

    template <typename T = DataType>
    size_t copy(DataView<T> other) noexcept {
        return copyAt(0, other);
    }

    template <typename T = DataType>
    size_t copyConsumeAt(size_t offset, DataView<T> &other) noexcept {
        static_assert(
            sizeof(DataT) == sizeof(T),
            "Cannot copy view from fundamentally different type sizes");
        auto len = sizeAt(offset, other.size());
        if (!len) return 0;

        std::memcpy(castAt(offset, len), other.cast(len), len);

        auto remaining = other.slice(len);
        std::advance(other, len);
        std::advance(*this, len);
        return len;
    }

    template <typename T = DataType>
    auto copyConsume(DataView<T> &other) noexcept {
        return copyConsumeAt(0, other);
    }

    template <typename T = DataType>
    DataView consumeSlice(size_t size) noexcept {
        auto copy = this->sliceAt<T>(0, size);
        m_data += copy.size();
        ;
        m_size -= copy.size();
        return copy;
    }

    template <typename T>
    bool operator==(const DataView<T> &other) const noexcept {
        return other.size() == size() &&
               memcmp(data(), other.data(), size()) == 0;
    }

    template <typename T>
    bool operator==(const Data<T> &other) const noexcept {
        return other.size() == size() &&
               memcmp(data(), other.data(), size()) == 0;
    }

    template <typename T>
    bool operator!=(const DataView<T> &other) const noexcept {
        return !(*this == other);
    }

    template <typename T>
    bool operator!=(const Data<T> &other) const noexcept {
        return !(*this == other);
    }

    DataView &operator+=(size_t distance) noexcept {
        ASSERT_MSG(m_size >= distance,
                   "Attempting to increment beyond the bounds of a data view");
        m_data = m_data + distance;
        m_size -= distance;
        if (!m_size) m_data = nullptr;
        return *this;
    }

    DataView operator++() noexcept {
        ASSERT_MSG(m_size > 0, "Attempting to increment an empty data view");
        m_data = m_data + 1;
        m_size--;
        if (!m_size) m_data = nullptr;
        return *this;
    }

    DataView operator++(int) noexcept {
        ASSERT_MSG(m_size > 0, "Attempting to increment an empty data view");
        auto clone = *this;
        m_data = m_data + 1;
        m_size--;
        if (!m_size) m_data = nullptr;
        return clone;
    }

    DataView operator+(int distance) noexcept {
        ASSERT_MSG(m_size > 0, "Attempting to increment an empty data view");
        ASSERT_MSG(m_size >= distance,
                   "Attempting to increment an empty data view");
        return sliceAt(distance);
    }

    operator string::StrView<ElemType>() const noexcept {
        return {data(), size()};
    }

    operator DataType *() noexcept {
        if (empty()) return nullptr;
        return m_data;
    }

    operator const DataType *() const noexcept {
        if (empty()) return nullptr;
        return m_data;
    }

    DataType *data() noexcept { return m_data; }

    const DataType *data() const noexcept { return m_data; }

    template <typename T = DataType>
    decltype(auto) castAt(size_t offset,
                          Opt<size_t> expectedLength = {}) noexcept {
        if constexpr (traits::IsStrViewV<T>) {
            static_assert(
                sizeof(DataType) == sizeof(traits::IdentifyValueType<T>),
                "Cannot cast to TextView with fundamentally different type "
                "size");
            auto len = expectedLength.value_or(size());
            return T{&at(offset, len), len};
        } else if constexpr (IsConst) {
            auto len = expectedLength.value_or(sizeof(T));
            return _reCast<const T *>(&at(offset, len));
        } else {
            auto len = expectedLength.value_or(sizeof(T));
            return _reCast<T *>(&at(offset, len));
        }
    }

    template <typename T = DataType,
              typename = std::enable_if_t<std::is_standard_layout_v<T>>>
    decltype(auto) castAt(size_t offset,
                          Opt<size_t> expectedLength = {}) const noexcept {
        return _reCast<const T *>(&at(offset, expectedLength));
    }

    template <typename T = DataType>
    decltype(auto) cast(Opt<size_t> expectedLength = {}) noexcept {
        return castAt<T>(0, expectedLength);
    }

    template <typename T = DataType>
    decltype(auto) cast(Opt<size_t> expectedLength = {}) const noexcept {
        return castAt<T>(0, expectedLength);
    }

    DataType &operator[](size_t index) noexcept { return at(index); }

    const DataType &operator[](size_t index) const noexcept {
        return at(index);
    }

    DataType &operator*() noexcept { return at(0); }

    DataType &front() const noexcept { return at(0); }

    explicit operator bool() const noexcept { return size() != 0; }

    decltype(auto) back() const noexcept {
        ASSERTD_MSG(size() != 0, "Attempt to call back on empty data view");
        return at(size() - 1);
    }

    decltype(auto) front() noexcept { return at(0); }

    decltype(auto) back() noexcept {
        ASSERTD_MSG(size() != 0, "Attempt to call back on empty data view");
        return at(size() - 1);
    }

    auto reset() noexcept {
        m_data = nullptr;
        m_size = 0;
    }

    decltype(auto) begin() const { return m_data; }
    decltype(auto) end() const { return m_data + m_size; }

    decltype(auto) begin() { return m_data; }
    decltype(auto) end() { return m_data + m_size; }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        if (empty()) return;

        buff << "Size: " << size() << " Data: ";
        if constexpr (sizeof(DataT) == 1)
            buff << crypto::hexEncode(*this);
        else {
            for (auto i = 0; i < size() && i < 256; i++) {
                auto num = at(i);
                if (i) buff << ", ";
                buff << num;
            }
        }
    }

private:
    DataType *m_data = nullptr;
    size_t m_size = 0;
};

}  // namespace ap::memory

// Allow DataView to operate in a hash
// Allow DataView to operate in a hash
template <typename DataT>
struct std::hash<::ap::memory::DataView<DataT>> {
    size_t operator()(
        const ::ap::memory::DataView<DataT> &view) const noexcept {
        // Cast to uint8_t string view for hashing
        auto strView = _cast<::ap::string::StrView<uint8_t>>(view);

        // Custom hash implementation since
        // std::hash<std::basic_string_view<uint8_t>> is not provided by the
        // standard library
        size_t hash = 0;
        for (auto byte : strView) {
            hash ^= std::hash<uint8_t>{}(byte) + 0x9e3779b9 + (hash << 6) +
                    (hash >> 2);
        }
        return hash;
    }
};
