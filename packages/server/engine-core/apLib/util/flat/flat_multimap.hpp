// Copyright Pubby 2016
// Distributed under the Boost Software License, Version 1.0.
// http://www.boost.org/LICENSE_1_0.txt

#ifndef LIB_FLAT_FLAT_MULTIMAP_HPP
#define LIB_FLAT_FLAT_MULTIMAP_HPP

#include "impl/flat_impl.hpp"

namespace fc {
namespace impl {

template <typename D, typename Key, typename Container, typename Compare,
          typename = void>
class flat_multimap_base
    : public flat_container_base<D, Key, Container, Compare> {
#include "impl/container_traits.hpp"
    using mapped_type = typename value_type::second_type;
    using B = flat_container_base<D, Key, Container, Compare>;
    D const* self() const { return static_cast<D const*>(this); }
    D* self() { return static_cast<D*>(this); }

public:
    using value_compare = first_compare<value_type, Compare>;
    value_compare value_comp() const { return value_compare(B::key_comp()); }

    using B::erase;
    using B::insert;

    // Modifiers

    iterator insert(value_type const& value) {
        iterator it = self()->upper_bound(value.first);
        return self()->container.insert(it.underlying, value);
    }

    iterator insert(value_type&& value) {
        iterator it = self()->upper_bound(value.first);
        return self()->container.insert(it.underlying, std::move(value));
    }

    template <class InputIt>
    void insert(InputIt first, InputIt last, delay_sort_t) {
        this->ds_insert_(first, last);
    }

    size_type erase(key_type const& key) {
        auto it_pair = self()->equal_range(key);
        std::size_t ret = std::distance(it_pair.first, it_pair.second);
        self()->container.erase(it_pair.first.underlying,
                                it_pair.second.underlying);
        return ret;
    }

    // Lookup

    size_type count(key_type const& key) const {
        auto it_pair = self()->equal_range(key);
        return std::distance(it_pair.first, it_pair.second);
    }
};

template <typename D, typename Key, typename Container, typename Compare>
class flat_multimap_base<D, Key, Container, Compare,
                         std::void_t<typename Compare::is_transparent>>
    : public flat_multimap_base<D, Key, Container, Compare, int> {
#include "impl/container_traits.hpp"
    using mapped_type = typename value_type::second_type;
    using B = flat_multimap_base<D, Key, Container, Compare, int>;
    D const* self() const { return static_cast<D const*>(this); }
    D* self() { return static_cast<D*>(this); }

public:
    using B::count;
    using B::insert;

    // Modifiers

    template <class P>
    iterator insert(P&& value) {
        iterator it = self()->upper_bound(value.first);
        return self()->container.insert(it.underlying, std::forward<P>(value));
    }

    // Lookup

    template <typename K>
    size_type count(K const& key) const {
        auto it_pair = self()->equal_range(key);
        return std::distance(it_pair.first, it_pair.second);
    }
};

}  // namespace impl

template <typename Container, typename Compare = std::less<void>>
class flat_multimap
    : public impl::flat_multimap_base<
          flat_multimap<Container, Compare>,
          typename Container::value_type::first_type, Container, Compare> {
#define FLATNAME flat_multimap
#define FLATKEY typename Container::value_type::first_type
#include "impl/class_def.hpp"
#undef FLATNAME
#undef FLATKEY
};

template <typename Key, typename T, typename Compare = std::less<void>>
using vector_multimap = flat_multimap<std::vector<std::pair<Key, T>>, Compare>;

template <typename Container, typename Compare>
inline bool operator==(const flat_multimap<Container, Compare>& lhs,
                       const flat_multimap<Container, Compare>& rhs) {
    return lhs.container == rhs.container;
}
template <typename Container, typename Compare>
inline bool operator!=(const flat_multimap<Container, Compare>& lhs,
                       const flat_multimap<Container, Compare>& rhs) {
    return lhs.container != rhs.container;
}

}  // namespace fc

#endif
