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

namespace ap {

// The count object represents a counted number that is rendered
// as a human delimited string. It will also self initialize to zero.
class Count {
public:
    using ValueType = int64_t;

    template <typename CountType,
              typename = std::enable_if_t<std::is_arithmetic_v<CountType>>>
    constexpr Count(CountType byteValue) noexcept
        : m_value(_nc<ValueType>(byteValue)) {}

    constexpr Count() noexcept : m_value(0) {}

    constexpr operator ValueType() noexcept { return m_value; }

    Count(const Count &size) noexcept : m_value(size.m_value) {}

    Count &operator=(const Count &size) noexcept {
        m_value = size.m_value;
        return *this;
    }

    Count &operator++(int) noexcept {
        m_value++;
        return *this;
    }

    Count &operator--() noexcept {
        m_value--;
        return *this;
    }

    Count &operator+=(const Count &size) noexcept {
        m_value += size.m_value;
        return *this;
    }

    Count &operator-=(const Count &size) noexcept {
        m_value -= size.m_value;
        return *this;
    }

    Count operator+(const Count &size) const noexcept {
        Count newCount(m_value);

        newCount.m_value += size.m_value;

        return newCount;
    }

    Count operator-(const Count &size) const noexcept {
        Count newCount(m_value);

        newCount.m_value -= size.m_value;

        return newCount;
    }

    template <class T = size_t>
    T asNumber() const noexcept {
        return _nc<T>(m_value);
    }

    constexpr bool operator<(Count size) const noexcept {
        return m_value < _cast<ValueType>(size);
    }
    constexpr bool operator<=(Count size) const noexcept {
        return m_value <= _cast<ValueType>(size);
    }
    constexpr bool operator>(Count size) const noexcept {
        return m_value > _cast<ValueType>(size);
    }
    constexpr bool operator>=(Count size) const noexcept {
        return m_value >= _cast<ValueType>(size);
    }
    constexpr bool operator==(Count size) const noexcept {
        return m_value == _cast<ValueType>(size);
    }
    constexpr bool operator!=(Count size) const noexcept {
        return m_value != _cast<ValueType>(size);
    }

    constexpr bool operator<(uint32_t size) const noexcept {
        return m_value < _cast<ValueType>(size);
    }
    constexpr bool operator<=(uint32_t size) const noexcept {
        return m_value <= _cast<ValueType>(size);
    }
    constexpr bool operator>(uint32_t size) const noexcept {
        return m_value > _cast<ValueType>(size);
    }
    constexpr bool operator>=(uint32_t size) const noexcept {
        return m_value >= _cast<ValueType>(size);
    }
    constexpr bool operator==(uint32_t size) const noexcept {
        return m_value == _cast<ValueType>(size);
    }
    constexpr bool operator!=(uint32_t size) const noexcept {
        return m_value != _cast<ValueType>(size);
    }

    constexpr bool operator<(uint64_t size) const noexcept {
        return m_value < _cast<ValueType>(size);
    }
    constexpr bool operator<=(uint64_t size) const noexcept {
        return m_value <= _cast<ValueType>(size);
    }
    constexpr bool operator>(uint64_t size) const noexcept {
        return m_value > _cast<ValueType>(size);
    }
    constexpr bool operator>=(uint64_t size) const noexcept {
        return m_value >= _cast<ValueType>(size);
    }
    constexpr bool operator==(uint64_t size) const noexcept {
        return m_value == _cast<ValueType>(size);
    }
    constexpr bool operator!=(uint64_t size) const noexcept {
        return m_value != _cast<ValueType>(size);
    }

#if ROCKETRIDE_PLAT_MAC
    constexpr bool operator<(size_t size) const noexcept {
        return m_value < _cast<ValueType>(size);
    }
    constexpr bool operator<=(size_t size) const noexcept {
        return m_value <= _cast<ValueType>(size);
    }
    constexpr bool operator>(size_t size) const noexcept {
        return m_value > _cast<ValueType>(size);
    }
    constexpr bool operator>=(size_t size) const noexcept {
        return m_value >= _cast<ValueType>(size);
    }
    constexpr bool operator==(size_t size) const noexcept {
        return m_value == _cast<ValueType>(size);
    }
    constexpr bool operator!=(size_t size) const noexcept {
        return m_value != _cast<ValueType>(size);
    }
#endif

    constexpr bool operator<(ValueType size) const noexcept {
        return m_value < size;
    }
    constexpr bool operator<=(ValueType size) const noexcept {
        return m_value <= size;
    }
    constexpr bool operator>(ValueType size) const noexcept {
        return m_value > size;
    }
    constexpr bool operator>=(ValueType size) const noexcept {
        return m_value >= size;
    }
    constexpr bool operator==(ValueType size) const noexcept {
        return m_value == size;
    }
    constexpr bool operator!=(ValueType size) const noexcept {
        return m_value != size;
    }

    constexpr bool operator<(int32_t size) const noexcept {
        return m_value < size;
    }
    constexpr bool operator<=(int32_t size) const noexcept {
        return m_value <= size;
    }
    constexpr bool operator>(int32_t size) const noexcept {
        return m_value > size;
    }
    constexpr bool operator>=(int32_t size) const noexcept {
        return m_value >= size;
    }
    constexpr bool operator==(int32_t size) const noexcept {
        return m_value == size;
    }
    constexpr bool operator!=(int32_t size) const noexcept {
        return m_value != size;
    }

    long double operator/(const time::seconds duration) const noexcept {
        if (duration.count() != 0)
            return m_value / _cast<long double>(duration.count());
        return 0;
    }

    explicit constexpr operator bool() const noexcept { return m_value != 0; }

    constexpr bool isNegative() const noexcept { return m_value < 0; }

    constexpr bool isPositive() const noexcept { return m_value > 0; }

    constexpr bool isZero() const noexcept { return m_value == 0; }

    friend std::ostream &operator<<(std::ostream &stream,
                                    const Count &count) noexcept {
        if (count.m_value == MaxValue<ValueType>) return stream << "{max}";
        return stream << string::toHumanCount(count.m_value);
    }

    template <typename Buffer>
    auto __toString(Buffer &buff, const FormatOptions &opts) const noexcept {
        if (opts.hex())
            _tsbo(buff, opts, m_value);
        else {
            if (m_value == MaxValue<ValueType>)
                buff << "{max}";
            else
                buff << string::toHumanCount(m_value);
        }
    }

    template <typename Buffer>
    static Error __fromString(Count &count, const Buffer &buff) noexcept {
        if (buff.toString().equals("{max}", false))
            count = MaxValue<ValueType>;
        else {
            auto res = _fsc<ValueType>(buff);
            if (!res) return res.ccode();
            count = *res;
        }
        return {};
    }

    operator std::size_t() const noexcept { return _nc<std::size_t>(m_value); }

    template <typename T>
    T cast() const noexcept {
        return _nc<T>(m_value);
    }

protected:
    ValueType m_value;
};

}  // namespace ap

namespace std {
// Specialize std::numeric_limits for Count
template <>
class numeric_limits<::ap::Count> {
public:
    static constexpr ::ap::Count min() noexcept {
        return {::ap::MinValue<::ap::Count::ValueType>};
    }
    static constexpr ::ap::Count max() noexcept {
        return {::ap::MaxValue<::ap::Count::ValueType>};
    }
};
}  // namespace std
