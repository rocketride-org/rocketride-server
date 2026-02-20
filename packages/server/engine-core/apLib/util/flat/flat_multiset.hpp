// Copyright Pubby 2016
// Distributed under the Boost Software License, Version 1.0.
// http://www.boost.org/LICENSE_1_0.txt

#ifndef LIB_FLAT_FLAT_MULTISET_HPP
#define LIB_FLAT_FLAT_MULTISET_HPP

#include "impl/flat_impl.hpp"

namespace fc {
namespace impl {

template <typename D, typename Key, typename Container, typename Compare,
          typename = void>
class flat_multiset_base
    : public flat_container_base<D, Key, Container, Compare> {
#include "impl/container_traits.hpp"
    using B = flat_container_base<D, Key, Container, Compare>;
    D const* self() const { return static_cast<D const*>(this); }
    D* self() { return static_cast<D*>(this); }

public:
    using value_compare = Compare;
    value_compare value_comp() const { return value_compare(B::key_comp()); }

    using B::erase;
    using B::insert;

    // Modifiers

    iterator insert(value_type const& value) {
        iterator it = self()->upper_bound(value);
        return self()->container.insert(it.underlying, value);
    }

    iterator insert(value_type&& value) {
        iterator it = self()->upper_bound(value);
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
class flat_multiset_base<D, Key, Container, Compare,
                         std::void_t<typename Compare::is_transparent>>
    : public flat_multiset_base<D, Key, Container, Compare, int> {
#include "impl/container_traits.hpp"
    using B = flat_multiset_base<D, Key, Container, Compare, int>;
    D const* self() const { return static_cast<D const*>(this); }
    D* self() { return static_cast<D*>(this); }

public:
    using B::count;

    // Lookup

    template <typename K>
    size_type count(K const& key) const {
        auto it_pair = self()->equal_range(key);
        return std::distance(it_pair.first, it_pair.second);
    }
};

}  // namespace impl

template <typename Container, typename Compare = std::less<void>>
class flat_multiset
    : public impl::flat_multiset_base<flat_multiset<Container, Compare>,
                                      typename Container::value_type, Container,
                                      Compare> {
#define FLATNAME flat_multiset
#define FLATKEY typename Container::value_type
#include "impl/class_def.hpp"
#undef FLATNAME
#undef FLATKEY
};

template <typename T, typename Compare = std::less<void>>
using vector_multiset = flat_multiset<std::vector<T>, Compare>;

template <typename Container, typename Compare>
inline bool operator==(const flat_multiset<Container, Compare>& lhs,
                       const flat_multiset<Container, Compare>& rhs) {
    return lhs.container == rhs.container;
}
template <typename Container, typename Compare>
inline bool operator!=(const flat_multiset<Container, Compare>& lhs,
                       const flat_multiset<Container, Compare>& rhs) {
    return lhs.container != rhs.container;
}

}  // namespace fc

#endif
