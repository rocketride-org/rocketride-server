// Copyright Pubby 2016
// Distributed under the Boost Software License, Version 1.0.
// http://www.boost.org/LICENSE_1_0.txt

#ifndef LIB_FLAT_FLAT_MAP_HPP
#define LIB_FLAT_FLAT_MAP_HPP

#include "impl/flat_impl.hpp"

namespace fc {
namespace impl {

template <typename D, typename Key, typename Container, typename Compare,
          typename = void>
class flat_map_base : public flat_container_base<D, Key, Container, Compare> {
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

    // Element access

    mapped_type const* has(key_type const& key) const {
        const_iterator it = self()->find(key);
        return it == self()->end() ? nullptr : &it.underlying->second;
    }

    mapped_type* has(key_type const& key) {
        iterator it = self()->find(key);
        return it == self()->end() ? nullptr : &it.underlying->second;
    }

    mapped_type const& at(key_type const& key) const {
        if (mapped_type const* ptr = has(key)) return *ptr;
        throw std::out_of_range("flat_map::at");
    }

    mapped_type& at(key_type const& key) {
        if (mapped_type* ptr = has(key)) return *ptr;
        throw std::out_of_range("flat_map::at");
    }

    mapped_type& operator[](key_type const& key) {
        return self()->try_emplace(key).first.underlying->second;
    }

    mapped_type& operator[](key_type&& key) {
        return self()->try_emplace(std::move(key)).first.underlying->second;
    }

    // Modifiers

    std::pair<iterator, bool> insert(value_type const& value) {
        return insert_(value);
    }

    std::pair<iterator, bool> insert(value_type&& value) {
        return insert_(std::move(value));
    }

    template <class InputIt>
    void insert(InputIt first, InputIt last, delay_sort_t) {
        this->ds_insert_(first, last);
        auto it =
            std::unique(self()->container.begin(), self()->container.end(),
                        impl::eq_comp<value_compare>{value_comp()});
        self()->container.erase(it, self()->container.end());
    }

    template <typename M>
    std::pair<iterator, bool> insert_or_assign(key_type const& key, M&& obj) {
        return insert_or_assign_(key, std::forward<M>(obj));
    }

    template <typename M>
    std::pair<iterator, bool> insert_or_assign(key_type&& key, M&& obj) {
        return insert_or_assign_(std::move(key), std::forward<M>(obj));
    }

    template <typename M>
    std::pair<iterator, bool> insert_or_assign(const_iterator hint,
                                               key_type const& key, M&& obj) {
        return insert_or_assign(key, std::forward<M>(obj));
    }

    template <typename M>
    std::pair<iterator, bool> insert_or_assign(const_iterator hint,
                                               key_type&& key, M&& obj) {
        return insert_or_assign(std::move(key), std::forward<M>(obj));
    }

    template <typename... Args>
    std::pair<iterator, bool> try_emplace(key_type const& key, Args&&... args) {
        return try_emplace_(key, std::forward<Args>(args)...);
    }

    template <typename... Args>
    std::pair<iterator, bool> try_emplace(key_type&& key, Args&&... args) {
        return try_emplace_(std::move(key), std::forward<Args>(args)...);
    }

    template <typename... Args>
    iterator try_emplace(const_iterator hint, key_type const& key,
                         Args&&... args) {
        return try_emplace_(key, std::forward<Args>(args)...).first;
    }

    template <typename... Args>
    iterator try_emplace(const_iterator hint, key_type&& key, Args&&... args) {
        return try_emplace_(std::move(key), std::forward<Args>(args)...).first;
    }

    size_type erase(key_type const& key) {
        const_iterator it = self()->find(key);
        if (it == self()->end()) return 0;
        self()->container.erase(it.underlying);
        return 1;
    }

    // Lookup

    size_type count(key_type const& key) const {
        return self()->find(key) != self()->end();
    }

private:
    template <typename V>
    std::pair<iterator, bool> insert_(V&& value) {
        iterator it = self()->lower_bound(value.first);
        if (it == self()->end() || self()->value_comp()(value, *it)) {
            it =
                self()->container.insert(it.underlying, std::forward<V>(value));
            return std::make_pair(it, true);
        }
        return std::make_pair(it, false);
    }

    template <typename K, typename M>
    std::pair<iterator, bool> insert_or_assign_(K&& key, M&& obj) {
        iterator it = self()->lower_bound(key);
        if (it == self()->end() || self()->key_comp()(key, it->first)) {
            it = self()->container.insert(
                it.underlying,
                value_type(std::forward<K>(key), std::forward<M>(obj)));
            return std::make_pair(it, true);
        }
        it.underlying->second = std::forward<M>(obj);
        return std::make_pair(it, false);
    }

    template <typename K, typename... Args>
    std::pair<iterator, bool> try_emplace_(K&& key, Args&&... args) {
        iterator it = self()->lower_bound(key);
        if (it == self()->end() || self()->key_comp()(key, it->first)) {
            it = self()->container.emplace(
                it.underlying,
                value_type(std::piecewise_construct,
                           std::forward_as_tuple(std::forward<K>(key)),
                           std::forward_as_tuple(std::forward<Args>(args)...)));
            return std::make_pair(it, true);
        }
        return std::make_pair(it, false);
    }
};

template <typename D, typename Key, typename Container, typename Compare>
class flat_map_base<D, Key, Container, Compare,
                    std::void_t<typename Compare::is_transparent>>
    : public flat_map_base<D, Key, Container, Compare, int> {
#include "impl/container_traits.hpp"
    using mapped_type = typename value_type::second_type;
    using B = flat_map_base<D, Key, Container, Compare, int>;
    D const* self() const { return static_cast<D const*>(this); }
    D* self() { return static_cast<D*>(this); }

public:
    using B::count;
    using B::insert;

    // Modifiers

    template <class P>
    std::pair<iterator, bool> insert(P&& value) {
        iterator it = self()->lower_bound(value.first);
        if (it == self()->end() || self()->value_comp()(value, *it)) {
            it =
                self()->container.insert(it.underlying, std::forward<P>(value));
            return std::make_pair(it, true);
        }
        return std::make_pair(it, false);
    }

    // Lookup

    template <typename K>
    size_type count(K const& key) const {
        return self()->find(key) != self()->end();
    }
};

}  // namespace impl

template <typename Container, typename Compare = std::less<void>>
class flat_map
    : public impl::flat_map_base<flat_map<Container, Compare>,
                                 typename Container::value_type::first_type,
                                 Container, Compare> {
#define FLATNAME flat_map
#define FLATKEY typename Container::value_type::first_type
#include "impl/class_def.hpp"
#undef FLATNAME
#undef FLATKEY
};

template <typename Key, typename T, typename Compare = std::less<void>>
using vector_map = flat_map<std::vector<std::pair<Key, T>>, Compare>;

template <typename Container, typename Compare>
inline bool operator==(const flat_map<Container, Compare>& lhs,
                       const flat_map<Container, Compare>& rhs) {
    return lhs.container == rhs.container;
}
template <typename Container, typename Compare>
inline bool operator!=(const flat_map<Container, Compare>& lhs,
                       const flat_map<Container, Compare>& rhs) {
    return lhs.container != rhs.container;
}

}  // namespace fc

#endif
