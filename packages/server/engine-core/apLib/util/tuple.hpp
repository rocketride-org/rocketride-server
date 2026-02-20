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

namespace ap::util::tuple {

// Utility get api to get, and verify the type from the tuple.
template <typename T, typename V>
inline T getType(size_t index, V &&tuple) noexcept(false) {
    auto result = std::get<index>(std::forward<V>(tuple));
    static_assert(std::is_convertible_v<decltype(result), T>, "Invalid type");
    return static_cast<T>(result);
}

// Handy api that gives you the even or odd tuples froma tuple list
// credit goes to Arthur O'Dwyer from cpplang's #meta-programming slack channel
namespace {
template <bool>
struct zero_or_one {
    template <typename E>
    using type = std::tuple<E>;
};

template <>
struct zero_or_one<false> {
    template <typename E>
    using type = std::tuple<>;
};

template <typename Tuple,
          typename = std::make_index_sequence<std::tuple_size<Tuple>::value>>
struct just_evens;

template <typename... Es, size_t... Is>
struct just_evens<std::tuple<Es...>, std::index_sequence<Is...>> {
    using type = decltype(std::tuple_cat(
        std::declval<
            typename zero_or_one<Is % 2 == 0>::template type<Es>>()...));
};

template <typename Tuple,
          typename = std::make_index_sequence<std::tuple_size<Tuple>::value>>
struct just_odds;

template <typename... Es, size_t... Is>
struct just_odds<std::tuple<Es...>, std::index_sequence<Is...>> {
    using type = decltype(std::tuple_cat(
        std::declval<
            typename zero_or_one<Is % 2 != 0>::template type<Es>>()...));
};

static_assert(
    std::is_same<just_evens<std::tuple<char, short, int, long, double>>::type,
                 std::tuple<char, int, double>>::value,
    "");
static_assert(
    std::is_same<just_odds<std::tuple<char, short, int, long, double>>::type,
                 std::tuple<short, long>>::value,
    "");

////////////////////////////////////////////////

template <typename T>
constexpr auto zero_or_one_val(std::true_type, const T &t) {
    return std::tuple<T>(t);
}
template <typename T>
constexpr auto zero_or_one_val(std::false_type, const T &t) {
    return std::tuple<>();
}

template <typename... Es, size_t... Is>
constexpr auto just_evens_impl(const std::tuple<Es...> &input,
                               std::index_sequence<Is...>) {
    return std::tuple_cat(zero_or_one_val(std::integral_constant < bool,
                                          Is % 2 == 0 > {},
                                          std::get<Is>(input))...);
};

template <typename... Es, size_t... Is>
constexpr auto just_odds_impl(const std::tuple<Es...> &input,
                              std::index_sequence<Is...>) {
    return std::tuple_cat(zero_or_one_val(std::integral_constant < bool,
                                          Is % 2 != 0 > {},
                                          std::get<Is>(input))...);
};

}  // namespace

// extract just the odd indexes form a tuple
template <typename... Es>
constexpr auto justOdds(const std::tuple<Es...> &input) noexcept(false) {
    return just_odds_impl(input, std::make_index_sequence<sizeof...(Es)>{});
};

// extract just the even indexes form a tuple
template <typename... Es>
constexpr auto justEvens(const std::tuple<Es...> &input) noexcept(false) {
    return just_evens_impl(input, std::make_index_sequence<sizeof...(Es)>{});
};

// Iterate a tuple
template <typename F, typename... Ts, size_t... Is>
void forEach(const Tuple<Ts...> &tuple, F &&func,
             std::index_sequence<Is...>) noexcept(false) {
    using expander = int[];
    (void)expander{0, ((void)func(get<Is>(tuple)), 0)...};
}

template <typename F, typename... Ts>
inline void forEach(const Tuple<Ts...> &tuple, F &&func) noexcept(false) {
    forEach(tuple, std::forward<F>(func),
            std::make_index_sequence<sizeof...(Ts)>());
}

template <typename F, typename... Ts, size_t... Is>
void forEach(Tuple<Ts...> &tuple, F &&func,
             std::index_sequence<Is...>) noexcept(false) {
    using expander = int[];
    (void)expander{0, ((void)func(get<Is>(tuple)), 0)...};
}

template <typename F, typename... Ts>
inline void forEach(Tuple<Ts...> &tuple, F &&func) noexcept(false) {
    forEach(tuple, std::forward<F>(func),
            std::make_index_sequence<sizeof...(Ts)>());
}

// Iterate two tuples at once (they must be the same size)
template <typename F, typename... Ts1, typename... Ts2, size_t... Is>
void forEach(const Tuple<Ts1...> &tuple1, const Tuple<Ts2...> &tuple2, F &&func,
             std::index_sequence<Is...>) noexcept(false) {
    using expander = int[];
    (void)expander{0, ((void)func(get<Is>(tuple1), get<Is>(tuple2)), 0)...};
}

template <typename F, typename... Ts1, typename... Ts2>
inline void forEach(const Tuple<Ts1...> &tuple1, const Tuple<Ts2...> &tuple2,
                    F &&func) noexcept(false) {
    static_assert(std::tuple_size_v<Tuple<Ts1...>> ==
                  std::tuple_size_v<Tuple<Ts2...>>);
    forEach(tuple1, tuple2, std::forward<F>(func),
            std::make_index_sequence<sizeof...(Ts1)>());
}

template <typename F, typename... Ts1, typename... Ts2>
inline auto forEach(const Pair<Tuple<Ts1...>, Tuple<Ts2...>> &pair,
                    F &&func) noexcept(false) {
    return forEach(pair.first, pair.second, std::forward<F>(func));
}

}  // namespace ap::util::tuple
