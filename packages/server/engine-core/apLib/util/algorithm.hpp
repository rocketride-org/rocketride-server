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

//
// Algorithm style utilities that simplify the stl's core ones a bit
//
#pragma once

namespace ap::util {

namespace {

// So that all the callback based algorithms below inherit the same
// feature, we define this private namespaced helper to detect if
// the entry type is a pair, and if so it will expand the callback
// first and second args
template <typename Callback, typename Entry>
inline decltype(auto) callbackExpand(Callback &&pred, Entry &entry) {
    if constexpr (traits::IsPairV<std::decay_t<Entry>>)
        return pred(entry.first, _mv(entry.second));
    else
        return pred(entry);
};

template <typename Callback, typename Entry>
inline decltype(auto) callbackExpand(Callback &&pred, const Entry &entry) {
    if constexpr (traits::IsPairV<std::decay_t<Entry>>)
        return pred(entry.first, entry.second);
    else
        return pred(entry);
};

}  // namespace

// Transforms an iteratable type into another, assumes the value
// types match and returns the entry in the second container into
// the first one
template <typename ResultType, typename Container,
          typename = std::enable_if<!std::is_pointer_v<Container>>>
inline decltype(auto) transform(ResultType &result,
                                const Container &container) noexcept(false) {
    if constexpr (traits::IsSequenceContainerV<ResultType>) {
        if constexpr (traits::IsDetectedExact<void, traits::DetectReserveMethod,
                                              ResultType>{})
            result.reserve(result.size() + std::distance(std::begin(container),
                                                         std::end(container)));

        std::transform(std::begin(container), std::end(container),
                       std::back_inserter(result),
                       [](const auto &entry) { return entry; });
    } else {
        std::transform(std::begin(container), std::end(container),
                       std::inserter(result, result.begin()),
                       [](const auto &entry) { return entry; });
    }
    return result;
}

// Transforms an iteratable type into another, assumes the value
// types match and returns the entry in the second container into
// the first one
template <typename ResultType, typename Container,
          typename = std::enable_if<!std::is_pointer_v<Container>>>
inline auto transform(const Container &container) noexcept(false) {
    ResultType result;
    if constexpr (traits::IsSequenceContainerV<ResultType>) {
        std::transform(std::begin(container), std::end(container),
                       std::back_inserter(result),
                       [](const auto &entry) { return entry; });
    } else {
        std::transform(std::begin(container), std::end(container),
                       std::inserter(result, result.begin()),
                       [](const auto &entry) { return entry; });
    }
    return result;
}

// Transforms an iteratable type into another, using a callback to convert.
template <typename ResultType, typename InBeg, typename InEnd,
          typename Callback>
inline decltype(auto) transform(ResultType &result, InBeg &&beg, InEnd &&end,
                                Callback &&callback) noexcept(false) {
    if constexpr (traits::IsSequenceContainerV<ResultType>) {
        std::transform(
            beg, end, std::back_inserter(result), [&](const auto &entry) {
                return callbackExpand(std::forward<Callback>(callback), entry);
            });
    } else {
        std::transform(beg, end, std::inserter(result, result.begin()),
                       [&](const auto &entry) {
                           return callbackExpand(
                               std::forward<Callback>(callback), entry);
                       });
    }
    return result;
}

template <typename ResultType, typename Container, typename Callback,
          typename = std::enable_if<!std::is_pointer_v<Container>>>
inline decltype(auto) transform(ResultType &result, const Container &container,
                                Callback &&callback) noexcept(false) {
    return transform(result, std::begin(container), std::end(container),
                     std::forward<Callback>(callback));
}

// Transforms an iteratable type into another, using a callback to convert.
template <typename ResultType, typename Container, typename Callback,
          typename = std::enable_if<!std::is_pointer_v<Container>>>
inline ResultType transform(const Container &container,
                            Callback &&callback) noexcept(false) {
    ResultType result;
    transform(result, container, std::forward<Callback>(callback));
    return result;
}

// Returns true if the predicate returns true for all entries.
// @notes
// Both containers must be sorted with <
template <typename Container, typename Collection>
inline bool includes(const Container &haystack,
                     const Collection &needles) noexcept {
    return std::includes(std::begin(haystack), std::end(haystack),
                         std::begin(needles), std::end(needles));
}

template <typename To, typename From>
inline auto copyTo(To &to, const From &from,
                   Opt<size_t> size = {}) noexcept(false) {
    auto count = size.value_or(std::size(from));
    ASSERT_MSG(std::size(to) >= count,
               "Target smaller then requested copy count");
    ASSERT_MSG(std::size(from) >= count, "Source smaller then requested count");

    auto out = std::begin(to);
    auto in = std::begin(from);
    for (auto i = 0; i < count; i++) *out++ = *in++;

    return out;
}

template <
    typename To, typename FromBeg, typename FromEnd,
    typename = std::enable_if_t<traits::IsIteratorV<traits::StripT<FromEnd>>>>
inline auto addTo(To &to, FromBeg &&fromBeg,
                  FromEnd &&fromEnd) noexcept(false) {
    if constexpr (traits::IsSequenceContainerV<To>) {
        // Pmr vectors do not do the doubling growth pattern that std vector
        // does for various reasons so, for these types its important to deal
        // with capacity explicitly in our case we prefer the doubling model of
        // std:vector generally
        if constexpr (traits::IsSameTypeV<
                          typename To::allocator_type,
                          memory::PolyAllocator<typename To::value_type>>) {
            auto count = std::distance(fromBeg, fromEnd);
            if (to.capacity() < (to.size() + count))
                to.reserve(std::max(to.capacity() * 2, to.capacity() + count));
        }
        return std::copy(fromBeg, fromEnd, std::back_inserter(to));
    } else if constexpr (traits::IsAssociativeContainerV<To>) {
        return std::copy(fromBeg, fromEnd, std::inserter(to, std::end(to)));
    } else {
        return std::copy(fromBeg, fromEnd, std::inserter(to));
    }
}

template <typename To, typename From>
inline auto addTo(To &to, From &&from) noexcept(false) {
    return addTo(to, std::begin(from), std::end(from));
}

template <typename To, typename From>
inline auto addTo(To &to, From &&from, size_t size) noexcept(false) {
    return addTo(to, std::begin(from), std::begin(from) + size, size);
}

// Reverse wrappers for containers, used to easily perform
// range fors in reverse, example:
//
// std::vector<int> stuff = {1,2,3};
// for (auto &entry : util::reverse(stuff)) {
// 	... will iterate 3, 2, 3
// }
//
template <typename T>
struct reversion_wrapper {
    T &iterable;
};

template <typename T>
auto begin(reversion_wrapper<T> w) {
    return std::rbegin(w.iterable);
}

template <typename T>
auto end(reversion_wrapper<T> w) {
    return std::rend(w.iterable);
}

template <typename T>
reversion_wrapper<T> reverse(T &&iterable) {
    return {iterable};
}

// Copies items between two iterators, capped by a max size
template <typename IteratorOut, typename Entry>
inline auto fillTo(IteratorOut output, const Entry &entry,
                   size_t size) noexcept {
    ASSERT_MSG(size >= 0, "Invalid argument for fillTo, negaive copy size");
    if (size <= 0) return output;
    while (size--) *output++ = entry;
    return output;
}

// Copies items between two iterators, capped by a max size, also
// allows for a total size counter to simplify the limitation
// logic when doing character stuff
template <typename IteratorOut, typename Entry>
inline auto fillTo(IteratorOut output, const Entry &entry, size_t sizeToFill,
                   size_t &sizeRemaining) noexcept {
    ASSERT_MSG(sizeToFill >= 0,
               "Invalid argument for fillTo, negaive copy size");
    ASSERT_MSG(sizeRemaining >= 0,
               "Invalid argument for fillTo, negaive remaining size");

    if (sizeRemaining <= 0 || sizeToFill <= 0) return output;

    while (sizeRemaining && sizeToFill) {
        sizeRemaining--;
        sizeToFill--;
        *output++ = entry;
    }

    return output;
}

// Assigns an iterator to a value, and returns the iterator without
// and optionally advances it post assignment
template <typename IteratorOut, typename Entry>
inline auto assignTo(IteratorOut output, Entry &&value,
                     bool advance = false) noexcept {
    *output = std::forward<Entry>(value);
    if (advance) output++;
    return output;
}

// Looks for an entry in a container by calling a predicate on
// each one, or by comparing a value on each one
template <typename Container, typename PredicateOrValue>
inline bool allOf(const Container &c, PredicateOrValue &&pred) noexcept(false) {
    if (std::size(c) == 0) return false;

    for (auto it{std::begin(c)}, end{std::end(c)}; it != end; it++) {
        bool res = {};

        if constexpr (traits::HasGlobalEqualityOperatorV<
                          traits::IdentifyValueType<Container>,
                          PredicateOrValue>)
            res = *it == pred;
        else
            res = callbackExpand(std::forward<PredicateOrValue>(pred), *it);

        if (!res) return false;
    }
    return true;
}

// Looks for an entry in a container by calling a predicate on
// each one, or by comparing a value on each one
template <typename Container, typename PredicateOrValue>
inline bool noneOf(const Container &c,
                   PredicateOrValue &&pred) noexcept(false) {
    if (std::size(c) == 0) return true;

    for (auto it{std::begin(c)}, end{std::end(c)}; it != end; it++) {
        bool res = {};

        if constexpr (traits::HasGlobalEqualityOperatorV<
                          traits::IdentifyValueType<Container>,
                          PredicateOrValue>)
            res = *it == pred;
        else
            res = callbackExpand(std::forward<PredicateOrValue>(pred), *it);

        if (res) return false;
    }
    return true;
}

// Iterates over the items in the container and fires the callback
template <typename Container, typename Predicate>
inline void forEach(const Container &c, Predicate &&pred) noexcept(false) {
    if constexpr (traits::IsTupleV<Container>) {
        tuple::forEach(c, std::forward<Predicate>(pred));
    } else {
        for (auto it{std::begin(c)}, end{std::end(c)}; it != end; it++)
            callbackExpand(std::forward<Predicate>(pred), *it);
    }
}

// Looks for an entry in a container by calling a predicate on
// each one, or by comparing a value on each one
template <typename Container, typename PredicateOrValue>
constexpr bool anyOf(const Container &c,
                     PredicateOrValue &&pred) noexcept(false) {
    for (auto it{std::begin(c)}, end{std::end(c)}; it != end; it++) {
        bool res = {};

        if constexpr (traits::HasGlobalEqualityOperatorV<
                          traits::IdentifyValueType<Container>,
                          PredicateOrValue>)
            res = *it == pred;
        else
            res = callbackExpand(std::forward<PredicateOrValue>(pred), *it);

        if (res) return true;
    }
    return false;
}

// Looks for an entry in a container by calling a predicate or
// comparing a value on each element in the container
template <typename Iterator, typename PredicateOrValue>
inline auto findIf(const Iterator &begin, const Iterator &end,
                   PredicateOrValue &&pred) noexcept(false) {
    static_assert(!std::is_pointer_v<PredicateOrValue>);

    for (auto it{begin}; it != end; it++) {
        bool res = {};

        if constexpr (std::is_pointer_v<Iterator>) {
            if constexpr (traits::HasGlobalEqualityOperatorV<decltype(*it),
                                                             PredicateOrValue>)
                res = *it == pred;
            else
                res = callbackExpand(std::forward<PredicateOrValue>(pred), *it);
        } else {
            if constexpr (traits::HasGlobalEqualityOperatorV<
                              traits::IdentifyValueType<Iterator>,
                              PredicateOrValue>)
                res = *it == pred;
            else
                res = callbackExpand(std::forward<PredicateOrValue>(pred), *it);
        }

        if (res) return it;
    }

    return end;
}

template <typename Container, typename PredicateOrValue>
inline auto findIf(const Container &c,
                   PredicateOrValue &&pred) noexcept(false) {
    return findIf(std::begin(c), std::end(c),
                  std::forward<PredicateOrValue>(pred));
}

namespace {

// Create a simple id the internal wrappers around removeCallback
// return to control the process
enum class Cb { No, Yes, Stop };

// Internal call used by removeEach, removeIf
template <typename Container, typename Predicate>
inline size_t removeCallback(Container &c, Predicate &&pred) noexcept(false) {
    // Vector is special as its memory changes as it is resized so
    // move each element out of the way for each call to the callback
    // them move it out of place to clear it
    if constexpr (traits::IsVector<Container>::value) {
        Container result;
        size_t count = 0;
        for (size_t i = 0; i < c.size(); i++) {
            auto cbResult = pred(c[i]);
            if (cbResult == Cb::Yes)
                continue;
            else if (cbResult == Cb::No) {
                result.push_back(std::move(c[i]));
                count++;
            } else
                break;
        }

        c = std::move(result);
        return count;
    }
    // Other containers we can remove each in turn without shrinking it
    // right away, but instead calling erase inline
    else {
        size_t count = 0;
        for (auto it = std::begin(c);;) {
            if (it == std::end(c)) break;
            auto cbResult = pred(*it);
            if (cbResult == Cb::Yes) {
                it = c.erase(it);
                count++;
            } else if (cbResult == Cb::No)
                ++it;
            else
                break;
        }
        return count;
    }
}

}  // namespace

// Removes items from a container if the predicate is true
template <typename Container, typename PredicateOrValue>
inline size_t removeIf(Container &c, PredicateOrValue &&pred) noexcept(false) {
    return removeCallback(c, [&](auto &entry) noexcept {
        if constexpr (traits::HasGlobalEqualityOperatorV<
                          traits::IdentifyValueType<Container>,
                          PredicateOrValue>)
            return entry == pred ? Cb::Yes : Cb::No;
        else
            return callbackExpand(std::forward<PredicateOrValue>(pred), entry)
                       ? Cb::Yes
                       : Cb::No;
    });
}

// Counts an entry if the callback returns true or the type matches
template <typename Container, typename Predicate>
inline size_t countIf(Container &c, Predicate &&pred) noexcept(false) {
    size_t count = 0;
    for (auto it{std::begin(c)}, end{std::end(c)}; it != end; it++) {
        if (callbackExpand(std::forward<Predicate>(pred), *it)) count++;
    }
    return count;
}

// Like removeIf above except assumes true for all calls
template <typename Container, typename Callback>
inline auto removeEach(Container &c, Callback &&cb) noexcept(false) {
    return removeCallback(c, [&](auto &entry) {
        callbackExpand(std::forward<Callback>(cb), entry);
        return Cb::Yes;
    });
}

// Like forEach, except this is a sorting callback
template <typename Container, typename Predicate>
inline auto sortEach(Container &&c, Predicate &&pred) noexcept(false) {
    std::sort(std::begin(c), std::end(c),
              [&](const auto &lhs, const auto &rhs) { return pred(lhs, rhs); });
}

// Add the result of each callback
template <typename Container, typename Init, typename Predicate>
inline auto addEach(Container &&c, Init start,
                    Predicate &&pred) noexcept(false) {
    return std::accumulate(std::begin(c), std::end(c), start,
                           std::forward<Predicate>(pred));
}

// Are two iterable things equal to each other
template <typename To, typename From>
inline auto equalTo(const To &to, const From &from,
                    Opt<size_t> size = {}) noexcept(false) {
    auto count = size.value_or(from.size());

    ASSERT_MSG(count <= std::size(from), "Count", count,
               "exceeds size of source container", std::size(from));
    ASSERT_MSG(count <= std::size(to), "Count", count,
               "exceeds size of target container", std::size(to));

    return std::equal(
        // Compare the from starting at the beg, ending at the limit requested
        // or the total size of the container
        std::begin(from), std::next(std::begin(from), count),

        // Same for the to, cap it to the limit
        std::begin(to), std::next(std::begin(to), count));
}

// Looks for needle in haystack, returns the position in haystack where needle
// was found, or haystack::end if it could not be found
template <typename Haystack, typename Needle>
inline auto searchIn(const Haystack &haystack, const Needle &needle,
                     Opt<size_t> size = {}) noexcept(false) {
    auto count = size.value_or(needle.size());

    ASSERT_MSG(count <= std::size(needle), "Count", count,
               "exceeds size of source container", std::size(needle));
    ASSERT_MSG(count <= std::size(haystack), "Count", count,
               "exceeds size of target container", std::size(haystack));

    return std::search(
        // Compare the needle starting at the beg, ending at the limit requested
        // or the total size of the container
        std::begin(haystack), std::next(std::begin(haystack), count),

        // Same for the haystack, cap it haystack the limit
        std::begin(needle), std::next(std::begin(needle), count));
}

}  // namespace ap::util

#define _findIf ::ap::util::findIf
#define _forEach ::ap::util::forEach
#define _anyOf ::ap::util::anyOf
#define _allOf ::ap::util::allOf
#define _noneOf ::ap::util::noneOf
#define _removeIf ::ap::util::removeIf
#define _countIf ::ap::util::countIf
#define _equalTo ::ap::util::equalTo
#define _copyTo ::ap::util::copyTo
#define _searchIn ::ap::util::searchIn
#define _addTo ::ap::util::addTo
