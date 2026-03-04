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

// Rounds a floating point to a precision
inline long double adjustPrecision(long double value,
                                   size_t maxPrecision = 2) noexcept {
    return floor((value * pow(10, maxPrecision) + 0.5)) / pow(10, maxPrecision);
}

inline double adjustPrecision(double value, size_t maxPrecision = 2) noexcept {
    return floor((value * pow(10, maxPrecision) + 0.5)) / pow(10, maxPrecision);
}

// Checks if an arbitrary type is within a range, exclusive
template <typename T>
_const bool inRangeExclusive(const T &start, const T &elem,
                             const T &stop) noexcept {
    return start < elem && stop > elem;
}

// Checks if an arbitrary type is within a range, inclusive
template <typename T>
_const bool inRangeInclusive(const T &start, const T &elem,
                             const T &stop) noexcept {
    return start <= elem && stop >= elem;
}

// Makes a range of elements, type has to be incrementable
template <auto First, auto Last>
_const auto makeRange() noexcept {
    if constexpr (First > Last) {
        std::array<decltype(First), First - Last> result = {};
        auto index = 0;
        for (auto v = First; v < Last; v++) result[index++] = v;
        return result;
    } else {
        std::array<decltype(First), Last - First> result = {};
        auto index = 0;
        for (auto v = First; v < Last; v++) result[index++] = v;
        return result;
    }
}

// Creates a decayed copy of an arbitrary type
template <typename T>
inline std::decay_t<T> decay_copy(T &&v) noexcept {
    return std::forward<T>(v);
}

// Extract keys from an associative container
template <template <typename K, typename V, typename C,
                    typename A> typename Container,
          typename K, typename V, typename C, typename A>
inline auto extractKeys(const Container<K, V, C, A> &container) noexcept {
    std::vector<K> keys;
    keys.reserve(container.size());
    for (auto &[key, value] : container) keys.emplace_back(key);
    return keys;
}

template <template <typename ChrT> typename TraitT, typename ChrT>
inline int compare(ChrT lhs, ChrT rhs) noexcept {
    return TraitT<ChrT>::compare(&lhs, &rhs, 1);
}

template <typename Low = uint32_t, typename High = uint32_t>
_const auto split64(uint64_t val) noexcept {
    return makePair(_cast<Low>(val), _cast<High>(val >> 32));
}

}  // namespace ap::util
