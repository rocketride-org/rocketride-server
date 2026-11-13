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

namespace ap {

// The Size class represents a type safe Size, useful for ensuring the
// arguments you pass to functions can be type safe, for instances
// instead of passing around Dwords and naming the variable MB, or Bytes
// you can instead take an argument of type Size as a type safer alternative.
class Size {
public:
    using ValueType = std::size_t;

    // Size will construct from an arbitrary byte value, of any integral
    // type
    constexpr Size(ValueType byteValue) noexcept : m_byteValue(byteValue) {}

    constexpr Size() noexcept : m_byteValue(0) {}

    static inline constexpr ValueType kByte = 1ul;
    static inline constexpr ValueType kKilobyte = 1024ul;
    static inline constexpr ValueType kMegabyte = 1024ul * 1024;
    static inline constexpr ValueType kGigabyte = 1024ul * 1024 * 1024;
    static inline constexpr ValueType kTerabyte = 1024ull * 1024 * 1024 * 1024;

    // These static methods are useful for constructing sizes inline
    static constexpr Size bytes(long double number) noexcept {
        return (ValueType)number;
    }
    static constexpr Size kilobytes(long double number) noexcept {
        return (ValueType)(kKilobyte * number);
    }
    static constexpr Size megabytes(long double number) noexcept {
        return (ValueType)(kMegabyte * number);
    }
    static constexpr Size gigabytes(long double number) noexcept {
        return (ValueType)(kGigabyte * number);
    }
    static constexpr Size terabytes(long double number) noexcept {
        return (ValueType)(kTerabyte * number);
    }

    constexpr Size(Size &&size) : m_byteValue(size.m_byteValue) {}
    constexpr Size(const Size &size) : m_byteValue(size.m_byteValue) {}

    constexpr Size &operator=(const Size &size) {
        m_byteValue = size.m_byteValue;
        return *this;
    }

    constexpr Size &operator+=(const Size &size) noexcept {
        m_byteValue += size.m_byteValue;
        return *this;
    }

    constexpr Size &operator-=(const Size &size) noexcept {
        m_byteValue -= size.m_byteValue;
        return *this;
    }

    constexpr Size &operator*=(const Size &size) noexcept {
        m_byteValue *= size.m_byteValue;
        return *this;
    }

    constexpr Size &operator/=(const Size &size) noexcept {
        m_byteValue /= size.m_byteValue;
        return *this;
    }

    template <class T = size_t>
    T asBytes() const noexcept {
        return _nc<T>(m_byteValue);
    }

    template <class T = size_t>
    T asKilobytes() const noexcept {
        return _nc<T>(m_byteValue / kKilobyte);
    }

    template <class T = size_t>
    T asMegabytes() const noexcept {
        return _nc<T>(m_byteValue / kMegabyte);
    }

    template <class T = size_t>
    T asGigabytes() const noexcept {
        return _nc<T>(m_byteValue / kGigabyte);
    }

    template <class T = size_t>
    T asTerabytes() const noexcept {
        return _nc<T>(m_byteValue / kTerabyte);
    }

    template <typename T>
    static Size fromBytes(T size) noexcept {
        return {_nc<ValueType>(size)};
    }

    template <typename T>
    static Size fromKilobytes(T size) noexcept {
        return {_nc<ValueType>(size) * kKilobyte};
    }

    template <typename T>
    static Size fromMegabytes(T size) noexcept {
        return {_nc<ValueType>(size) * kMegabyte};
    }

    template <typename T>
    static Size fromGigabytes(T size) noexcept {
        return {_nc<ValueType>(size) * kGigabyte};
    }

    template <typename T>
    static Size fromTerabytes(T size) noexcept {
        return {_nc<ValueType>(size) * kTerabyte};
    }

    // Multiplication by another size
    constexpr Size operator*(Size amount) const noexcept {
        return {m_byteValue * amount.m_byteValue};
    }

    // Multiplication by byte size
    constexpr Size operator*(size_t amount) const noexcept {
        return {m_byteValue * amount};
    }

    // Multiplication by byte size
    constexpr Size operator*(uint32_t amount) const noexcept {
        return {m_byteValue * amount};
    }

    ValueType operator/(size_t size) const noexcept {
        if (size != 0) return m_byteValue / size;
        return 0;
    }

    // Division by a duration to get per/second rates
    long double operator/(const time::seconds duration) const noexcept {
        if (duration.count() != 0)
            return m_byteValue / static_cast<long double>(duration.count());
        return 0;
    }

    // Operator bool resolves to true if the value is non zero
    explicit constexpr operator bool() const noexcept {
        return m_byteValue != 0;
    }

    // Logical state methods decribing the inner value
    constexpr bool isZero() const noexcept { return m_byteValue == 0; }

    // String render method
    Text toString(bool includeBytes = false) const noexcept {
        auto result = string::toHumanSize(_nc<long double>(m_byteValue), 2);
        if (m_byteValue && includeBytes && m_byteValue > kKilobyte)
            result += " (" + string::toHumanCount(m_byteValue) + ")";
        return result;
    }

    // Friend for outputting to standard streams, the human readable form
    // of this size
    friend std::ostream &operator<<(std::ostream &stream,
                                    const Size &size) noexcept {
        return stream << size.toString();
    }

    // Returns a reference to the static map of postfixes to size constructors
    // for handling from human string conversions.
    static const auto &postfixMap() noexcept {
        static const std::map<iTextView, std::function<Size(long double)>>
            parsers = {{""_tv, Size::bytes},
                       {"B"_tv, Size::bytes},
                       {"BYTES"_tv, Size::bytes},
                       {"BYTE"_tv, Size::bytes},
                       {"KB"_tv, Size::kilobytes},
                       {"KILOBYTES"_tv, Size::kilobytes},
                       {"KILOBYTE"_tv, Size::kilobytes},
                       {"MB"_tv, Size::megabytes},
                       {"MEGABYTES"_tv, Size::megabytes},
                       {"MEGABYTE"_tv, Size::megabytes},
                       {"GB"_tv, Size::gigabytes},
                       {"GIGABYTES"_tv, Size::gigabytes},
                       {"GIGABYTE"_tv, Size::gigabytes},
                       {"TB"_tv, Size::terabytes},
                       {"TERABYTES"_tv, Size::terabytes},
                       {"TERABYTE"_tv, Size::terabytes}};

        return parsers;
    }

    template <typename Buffer>
    auto __toString(Buffer &buff, const FormatOptions &opts) const noexcept {
        if (opts.hex())
            _tsbo(buff, opts, m_byteValue);
        else if (opts.logging())
            buff << toString(true);
        else {
            if (m_byteValue == MaxValue<ValueType>)
                buff << "{max}";
            else
                buff << toString();
        }
    }

    // Accepts stream input to create a Size from a string
    template <typename Buffer>
    static Error __fromString(Size &result, const Buffer &buf,
                              const FormatOptions &opts) noexcept {
        // Copy the numeric portion up to the first non numeric/punctutation
        auto value = buf.toString();
        if (value.equals("{max}", false)) {
            result = MaxValue<ValueType>;
            return {};
        }

        // Skip the ox if present
        size_t i = 0;
        for (; i < value.size(); i++) {
            if (!std::isdigit(value[i]) && !std::ispunct(value[i])) {
                if (value[i] == 'x' && i != 0 && value[i - 1] == '0') continue;
                if (opts.hex()) {
                    if (_anyOf(std::array{'a', 'b', 'c', 'd', 'e', 'f'},
                               std::tolower(value[i])))
                        continue;
                }
                break;
            }
        }

        auto numberPortion = value.substr(0, i);

        // Eat any whitespace following the numeric component
        for (; i < value.size(); i++) {
            if (!string::isSpace(value[i])) break;
        }

        // Look for a leading portion, assume bytes if unspecified
        if (auto postfixPortion = value.substr(i)) {
            // Locate the lower bound using the first character, then proceed
            // forward in the prefix list to locate the right one
            static auto &map = postfixMap();
            if (auto iter = map.lower_bound(postfixPortion.substr(0, 1));
                iter != map.end()) {
                do {
                    if (postfixPortion.startsWith(iter->first, false)) {
                        auto res = _fsc<long double>(value, opts);
                        if (!res) return _mv(res.ccode());

                        result = iter->second(*res);
                        return {};
                    }
                    iter++;
                } while (iter != map.end());
            }
        }

        // Bytes can't be sliced so fetch as an integer size
        auto res = _fsc<ValueType>(value, opts);
        if (!res) return _mv(res.ccode());
        result = {_mv(*res)};
        return {};
    }

    // Size will auto cast to a size_t, as this is the typical use case
    constexpr operator ValueType() const noexcept { return m_byteValue; }

    // Downcast the size to some other numeric type
    template <typename T>
    T cast() const {
        return _nc<T>(m_byteValue);
    }

protected:
    ValueType m_byteValue;
};

}  // namespace ap

namespace std {
// Specialize std::numeric_limits for Size
template <>
class numeric_limits<::ap::Size> {
public:
    static constexpr ::ap::Size min() noexcept {
        return {::ap::MinValue<::ap::Size::ValueType>};
    }
    static constexpr ::ap::Size max() noexcept {
        return {::ap::MaxValue<::ap::Size::ValueType>};
    }
};
}  // namespace std