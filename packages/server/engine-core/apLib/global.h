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
//	Contains global definitions
//
#pragma once

namespace ap {

// Common flags to allow or exclude some features
#define CHUNKED_DOC_STRUCT  // allows to save document structure in chunks

// #define USE_BUCKET_ARRAY	// allows using bucket array in word index
#define USE_SLIDING_WINDOW  // allows algorithm using fixed size segment
                            // widiwing for wordId/docId pairs

#if defined USE_BUCKET_ARRAY && defined USE_SLIDING_WINDOW
#error USE_BUCKET_ARRAY and USE_SLIDING_WINDOW can not be defined at the same time
#endif

// #define KEEP_CASE_INDEX	// allows storage of case-sensitive index in word
// index file
#define INDEX_LAZY_INIT  // allows lazy inits for some wordDB indexes right
                         // before writing to word index

#if defined KEEP_CASE_INDEX && defined INDEX_LAZY_INIT
#error KEEP_CASE_INDEX and INDEX_LAZY_INIT can not be defined both at the same time
#endif

// Common definitions
#define BIT(n) ((uint32_t)(1l << n))

// The macros take a constant string of exactly 4 characters in length
// and create a uint32_t from them that shows up in memory dumps in the
// correct order
#define STR_CHARVAL(c) (0 + c)
#define STR_CHARSHIFT(c, n) (STR_CHARVAL(c) << n)
#define STR_DEFINE(str)                                                \
    ((uint32_t)((STR_CHARSHIFT(str[0], 0) | STR_CHARSHIFT(str[1], 8) | \
                 STR_CHARSHIFT(str[2], 16) | STR_CHARSHIFT(str[3], 24))))

// Handy macros for c++ reasons
#define _mv(x) std::move(x)
#define _mvOpt(x) std::move(*_exch(x, NullOpt))
#define _const static constexpr const
#define _inline static inline
#define _thread_local_inline static inline thread_local
#define _thread_local static thread_local
#define _forever() while (true)
#define _exch std::exchange
#define _tie std::tie
#define _zip ::boost::combine
#define _divRoundUp(x, y) (x % y ? (x / y) + 1 : (x / y))
#define _using(...) if (__VA_ARGS__; true)
#define _block() if (true)
#define _forward

using AlwaysT = std::enable_if_t<true>;

// Core global aliases for common types
template <typename T>
using SharedPtr = std::shared_ptr<T>;

template <typename T>
using WeakPtr = std::weak_ptr<T>;

template <typename T>
using UniquePtr = std::unique_ptr<T>;

template <typename T>
using UniquePtr = std::unique_ptr<T>;

template <typename T>
using Opt = std::optional<T>;

_const auto NullOpt = std::nullopt;
_const auto PieceConstruct = std::piecewise_construct;

template <typename T>
using Ref = std::reference_wrapper<T>;

template <typename T>
using CRef = std::reference_wrapper<const T>;

template <typename T>
_const auto makeRef(T &&arg) noexcept {
    return std::ref(std::forward<T>(arg));
}

template <typename T>
using Atomic = std::atomic<T>;

template <typename... T>
using Tuple = std::tuple<T...>;

template <typename T, typename Y>
using Pair = std::pair<T, Y>;

template <typename T, size_t S>
using Array = std::array<T, S>;

template <typename T>
using Function = std::function<T>;

template <typename T>
using Future = std::future<T>;

template <typename... T>
using Variant = std::variant<T...>;

template <typename T, typename V>
inline auto holds(V &&variant) noexcept {
    return std::holds_alternative<T>(variant);
}

template <typename T, typename V>
inline auto getIf(V &variant) noexcept {
    return std::get_if<T>(&variant);
}

template <typename T, typename V>
inline auto get(V &&variant) noexcept {
    return std::get<T>(variant);
}

template <typename... T>
using InitList = std::initializer_list<T...>;

template <typename T>
constexpr auto MaxValue = std::numeric_limits<T>::max();

template <typename T>
constexpr auto MinValue = std::numeric_limits<T>::lowest();

template <typename Key, typename T, typename Compare = std::less<Key>,
          typename Allocator = std::allocator<Pair<Key, T>>>
using FlatMap = ::fc::flat_map<std::vector<Pair<Key, T>, Allocator>, Compare>;

template <typename Key, typename T, typename Compare = std::less<Key>,
          typename Allocator = std::allocator<Pair<Key, T>>>
using FlatMultiMap =
    ::fc::flat_multimap<std::vector<Pair<Key, T>, Allocator>, Compare>;

template <typename T, typename Compare = std::less<T>,
          typename Allocator = std::allocator<T>>
using FlatSet = ::fc::flat_set<std::vector<T, Allocator>, Compare>;

template <typename Key, typename T, typename Compare = std::less<Key>>
using PolyFlatMap = ::fc::flat_map<PmrVector<Pair<Key, T>>, Compare>;

template <typename Key, typename T, typename Compare = std::less<Key>>
using PolyFlatMultiMap = ::fc::flat_multimap<PmrVector<Pair<Key, T>>, Compare>;

template <typename T, typename Compare = std::less<T>>
using PolyFlatSet = ::fc::flat_set<PmrVector<T>, Compare>;

using ErrorCode = std::error_code;

// Bridge placeholders into our root namespace so we can just use _1 _2 etc.
using namespace std::placeholders;

// Useful smart ptr helpers
template <typename T, typename... Args>
auto makeUnique(Args &&...args) noexcept(false) {
    return std::make_unique<T>(std::forward<Args>(args)...);
}

template <typename T, typename... Args>
auto makeShared(Args &&...args) noexcept(false) {
    return std::make_shared<T>(std::forward<Args>(args)...);
}

template <typename T, typename Callback>
auto makeUniqueCb(Callback &&cb) noexcept(false) {
    return std::make_unique<T>(cb());
}

template <typename T, typename Callback>
auto makeSharedCb(Callback &&cb) noexcept(false) {
    return std::make_shared<T>(cb());
}

template <typename First, typename Second>
constexpr decltype(auto) makePair(First &&first, Second &&second) noexcept {
    return std::make_pair(std::forward<First>(first),
                          std::forward<Second>(second));
}

template <typename... Args>
constexpr auto makeTuple(Args &&...args) noexcept {
    return std::make_tuple(std::forward<Args>(args)...);
}

template <typename T, typename F>
constexpr auto staticPtrCast(F &&from) noexcept {
    return std::static_pointer_cast<T>(std::forward<F>(from));
}

template <typename T, typename F>
constexpr auto polyPtrCast(F &&from) noexcept {
    return boost::polymorphic_pointer_downcast<T>(std::forward<F>(from));
}

template <typename SizeT>
_const auto alignUp(SizeT n,
                    size_t alignment = alignof(std::max_align_t)) noexcept {
    if (n % alignment)
        return static_cast<SizeT>((n + (alignment - 1)) & ~(alignment - 1));
    return n;
}

template <typename FirstT, typename SecondT>
using CompressedPair = boost::compressed_pair<FirstT, SecondT>;

// Dynamic cast wrapper for types, on release builds these are static casts
// on debug builds they are dynamic casts with a built in assert check
template <typename T, typename F>
inline T polymorphicCast(F &&arg) noexcept {
    return boost::polymorphic_downcast<T>(std::forward<F>(arg));
}
template <typename T, typename F>
inline T polymorphicConstCast(F &&arg) noexcept {
    return polymorphicCast<T>(
        const_cast<std::remove_const_t<F>>(std::forward<F>(arg)));
}

#define _cast static_cast
#define _constCast const_cast
#define _reCast reinterpret_cast
#define _dynCast dynamic_cast
#define _polyCast ::ap::polymorphicCast
#define _polyPtrCast ::ap::polyPtrCast
#define _polyConstCast ::ap::polymorphicConstCast
#define _bind std::bind
#define _visit std::visit
#define _apply std::apply
#define _tupleFwd std::forward_as_tuple

// Maximum name of a single object not including the null character (such as
// a filename component, not a path)
_const uint32_t MAX_OBJNAME = 1023;

// Maximum length of classification tags
_const uint32_t MAX_CLASSIFY = 8192;

// Maximum name of an entire path
_const uint32_t MAX_PATHNAME = 32768;

// Maximum name of a single object not including the null character
_const uint32_t MAX_SETNAME = 15;

// Maximum size of a string that can be read by IData::readLine(Text &). It
// is normally the size of an object (which is much smaller), but we may be
// reading an entire path (+//path line)
_const uint32_t MAX_READLINE = MAX_PATHNAME;

// The maximum size issued to services
_const uint32_t MAX_IOSIZE = 256 * 1024;

// The overhead we add to ensure the tag and the data fit in the buffers
_const uint32_t MAX_TAGOVERHEAD = 2048;

// The maximum size of a TAG, including data and any wrappers
_const uint32_t MAX_TAGSIZE = MAX_IOSIZE + MAX_TAGOVERHEAD;

// Maximum numbers of buffers supported by DataBuffer
_const uint32_t MAX_BUFFERS = 256;

// When you want a range for, in reverse
#define _foreachRev BOOST_REVERSE_FOREACH

}  // namespace ap
