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

namespace ap::string {

// A Pack adapter takes any kind of container, be it a DataView, TextView
// vector, array, or Text, and at compile time turns into a generic interface
// to said buffer, it for example will not have write apis on it if the
// source buffer is const, or is not resize-able. It also stores in it
// a position for streaming operations.
template <typename BackingT>
class PackAdapter {
public:
    using BackingType = BackingT;
    using Traits = traits::ContainerTraits<BackingT>;
    using ElemType = typename Traits::ValueType;
    using value_type = ElemType;
    using char_type = ElemType;

    static_assert(!traits::IsPackAdapterV<BackingT>, "Layering not allowed");

    _const auto IsDataView =
        traits::IsSameTypeV<BackingT, memory::DataView<ElemType>>;
    _const auto IsStringValue = traits::IsSameTypeV<ElemType, char> ||
                                traits::IsSameTypeV<ElemType, Utf16Chr>;
    _const auto IsStringView =
        std::is_base_of_v<std::basic_string_view<ElemType>, BackingT>;
    _const auto IsStringClass =
        std::is_base_of_v<std::basic_string<ElemType>, BackingT>;
    _const auto IsIntegralValue = std::is_integral_v<ElemType>;
    _const auto IsConst = std::is_const<BackingT>::value;
    _const auto IsConstElement = std::is_const<ElemType>::value;
    _const auto HasSize = Traits::HasSize;
    _const auto HasReserve = Traits::HasReserve;
    _const auto HasResize = Traits::HasResize;
    _const auto IsWriteable = !IsConst && !IsConstElement && !IsStringView;
    _const auto IsResizeable = HasResize;

    template <typename D>
    using EnableIfStringValue = std::enable_if_t<D::IsStringValue>;

    template <typename D>
    using EnableIfIntegralValue = std::enable_if_t<D::IsIntegralValue>;

    template <typename D>
    using EnableIfWriteable = std::enable_if_t<D::IsWriteable>;

    template <typename Iterator, typename D>
    using EnableIfCompatibleIter = std::enable_if<std::is_same_v<
        traits::IdentifyIteratorValueType<Iterator>, typename D::ElemType>>;

    PackAdapter(const PackAdapter &data) = default;
    PackAdapter(PackAdapter &&data) = default;

    PackAdapter &operator=(const PackAdapter &data) = default;
    PackAdapter &operator=(PackAdapter &&data) = default;

    PackAdapter(BackingT &container, size_t startPosition,
                size_t expectedLength = 0) noexcept
        : m_backingRef(container), m_backing(&container) {
        m_position = checkAvail(startPosition, expectedLength);
    }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    auto begin() {
        return m_backing->begin();
    }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    auto end() {
        return m_backing->end();
    }

    auto begin() const { return m_backing->begin(); }
    auto end() const { return m_backing->end(); }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    auto rbegin() {
        return m_backing->rbegin();
    }
    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    auto rend() {
        return m_backing->rend();
    }

    auto rbegin() const { return m_backing->rbegin(); }
    auto rend() const { return m_backing->rend(); }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    decltype(auto) back() {
        return m_backing->back();
    }

    decltype(auto) back() const { return m_backing->back(); }

    decltype(auto) front() const { return m_backing->front(); }

    size_t size() const noexcept { return m_backing->size(); }

    bool empty() const noexcept { return size() == 0; }

    size_t sizeAt(size_t pos) const noexcept {
        if (pos == CurPos) pos = m_position;
        return m_backing->size() - std::min(m_backing->size(), pos);
    }

    size_t availAt(size_t pos, size_t count) const noexcept {
        auto adjustedCount = std::min(sizeAt(pos), count);
        if (adjustedCount != count) m_writeCapped = true;
        return adjustedCount;
    }

    const ElemType &at(size_t pos, size_t expectedLength = 1) const noexcept {
        return *std::next(begin(), checkAvail(pos, expectedLength));
    }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    ElemType &at(size_t pos, size_t expectedLength = 1) noexcept {
        return *std::next(begin(), checkAvail(pos, expectedLength));
    }

    template <typename T = ElemType, typename D = PackAdapter,
              typename = EnableIfIntegralValue<D>>
    decltype(auto) cast(size_t pos = 0,
                        size_t expectedLength = 1) const noexcept {
        return reinterpret_cast<const T *>(&at(pos, expectedLength));
    }

    template <typename T = ElemType, typename D = PackAdapter,
              typename = EnableIfWriteable<D>,
              typename = EnableIfIntegralValue<D>>
    decltype(auto) cast(size_t pos = 0, size_t expectedLength = 1) noexcept {
        return reinterpret_cast<T *>(&at(pos, expectedLength));
    }

    template <typename D = PackAdapter, typename = EnableIfStringValue<D>>
    string::StrView<char_type> toView(size_t pos = 0,
                                      Opt<size_t> length = {}) const noexcept {
        if (empty()) return {};

        return {&at(pos, sizeAt(pos)), length.value_or(sizeAt(pos))};
    }

    template <typename D = PackAdapter, typename = EnableIfStringValue<D>>
    string::Str<char_type> toString(size_t pos = 0,
                                    Opt<size_t> length = {}) const noexcept {
        if (empty()) return {};

        return {&at(pos, sizeAt(pos)), length.value_or(sizeAt(pos))};
    }

    auto sliceAt(size_t offset = 0, Opt<size_t> sliceSize = {}) const noexcept {
        auto avail = sliceSize.value_or(sizeAt(offset));
        ASSERTD(avail > 0);
        return memory::DataView<const ElemType>{&at(offset, avail), avail};
    }

    auto slice(Opt<size_t> sliceSize = {}) const noexcept {
        return sliceAt(0, sliceSize);
    }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    size_t write(memory::DataView<const ElemType> data) noexcept {
        if (!data.empty()) writeAt(currentPos(), data.cast(), data.size());
        return currentPos();
    }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    size_t write(ElemType data, size_t count = 1) noexcept {
        auto writePosition = currentPos();
        reserve(count);
        for (auto i = 0; i < count; i++) writeAt(writePosition++, &data, 1);
        return currentPos();
    }

    template <typename Iterator, typename D = PackAdapter,
              typename = EnableIfCompatibleIter<Iterator, D>>
    size_t write(Iterator iter, size_t count) noexcept {
        if (!count) return currentPos();

        auto pos = currentPos();
        growTo(pos + count);

        if (count = availAt(pos, count); count) {
            auto start = begin() + pos;
            std::copy(iter, std::next(iter, count), start);
            return setPosition(pos + count);
        }

        return currentPos();
    }

    size_t write(std::string_view string) noexcept {
        if (!string.empty()) write(string.data(), string.size());
        return currentPos();
    }

    template <typename Iterator, typename D = PackAdapter,
              typename = EnableIfCompatibleIter<Iterator, D>>
    size_t read(Iterator iter, size_t count) const noexcept {
        if (!count) return currentPos();

        auto pos = currentPos();
        if (count = availAt(pos, count); count) {
            auto start = begin() + pos;
            std::copy(start, std::next(start, count), iter);
            return setPosition(pos + count);
        }

        return currentPos();
    }

    template <typename Input, typename D = PackAdapter,
              typename = EnableIfWriteable<D>>
    PackAdapter &operator<<(Input &&input) noexcept;

    size_t currentPos() const noexcept { return m_position; }

    size_t setPosition(size_t pos, size_t expectedLength = 0) const noexcept {
        if (pos == EndPos) {
            pos = size() ? size() - 1 : 0;
        } else if (pos == CurPos) {
            pos = 0;
        } else if (pos == NoPos) {
            ASSERTD_MSG(pos != NoPos, "Invalid position");
        }

        m_position = pos = checkAvail(pos, expectedLength);
        return m_position;
    }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    size_t growTo(size_t pos) {
        if (size() >= pos) return size();
        return growBy(pos - size());
    }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    size_t growBy(size_t total, bool force = false) {
        if constexpr (IsResizeable) m_backing->resize(size() + total);
        return size();
    }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    ElemType &operator*() noexcept {
        return at(0);
    }

    const ElemType &operator*() const noexcept { return at(0); }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    size_t write(const ElemType *data, size_t count) noexcept {
        if (!count) return currentPos();
        growTo(currentPos() + count);
        count = availAt(currentPos(), count);
        return writeAt(currentPos(), data, count);
    }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    void reserve(size_t count) noexcept {
        if constexpr (HasReserve) m_backing->reserve(size() + count);
    }

    auto writeCapped() const noexcept { return m_writeCapped; }

    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    void resize(size_t newSize) const noexcept {
        if constexpr (HasResize) m_backing->resize(newSize);
    }

private:
    template <typename D = PackAdapter, typename = EnableIfWriteable<D>>
    size_t writeAt(size_t pos, const ElemType *data, size_t count) noexcept {
        if (!count) return currentPos();
        growTo(pos + count);
        if (count = availAt(pos, count); count) memcpy(&at(pos), data, count);
        return setPosition(pos + count);
    }

    size_t checkAvail(size_t pos = 0,
                      size_t expectedLength = 1) const noexcept {
        pos = normalizePos(pos);
        ASSERTD_MSG(sizeAt(pos) >= expectedLength,
                    "Attempt to access adapter data at invalid pos:", pos,
                    "Buffer size:", size());
        return pos;
    }

    size_t normalizePos(size_t pos) const noexcept {
        if (pos == CurOrEndPos)
            pos = size();
        else if (pos == CurPos)
            pos = currentPos();
        else if (pos == EndPos)
            pos = size();
        else if (pos == CurOrBegPos)
            pos = 0;
        else if (pos == BegPos)
            pos = 0;
        else if (pos == NoPos)
            ASSERTD_MSG(pos != NoPos, "Invalid position");

        return pos;
    }

    Ref<BackingT> m_backingRef;
    BackingT *m_backing = nullptr;
    mutable size_t m_position = 0;
    mutable bool m_writeCapped = false;
};

}  // namespace ap::string
