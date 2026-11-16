// Copyright Pubby 2016
// Distributed under the Boost Software License, Version 1.0.
// http://www.boost.org/LICENSE_1_0.txt

#ifndef LIB_FLAT_FLAT_IMPL_HPP
#define LIB_FLAT_FLAT_IMPL_HPP

#include <algorithm>
#include <functional>
#include <iterator>
#include <utility>
#include <vector>

namespace fc {

struct delay_sort_t {};
constexpr delay_sort_t delay_sort = {};

struct container_construct_t {};
constexpr container_construct_t container_construct = {};

namespace impl {

template <typename Key>
using transparent_key_t = std::reference_wrapper<Key>;

template <typename Comp>
struct eq_comp {
    template <typename A, typename B>
    bool operator()(A const &lhs, B const &rhs) {
        return !comp(lhs, rhs) && !comp(rhs, lhs);
    }
    Comp comp;
};

template <typename It>
struct dummy_iterator {
    dummy_iterator() = delete;
    dummy_iterator(dummy_iterator const &) = delete;
    It underlying;
};

template <typename It, typename Convert,
          typename Tag = typename std::iterator_traits<It>::iterator_category>
class flat_iterator;

template <typename It, typename Convert>
class flat_iterator<It, Convert, std::random_access_iterator_tag> {
    using traits = std::iterator_traits<It>;

public:
    using difference_type = typename traits::difference_type;
    using value_type = typename traits::value_type const;
    using pointer = value_type *;
    using reference = value_type &;
    using iterator_category = std::random_access_iterator_tag;

    flat_iterator() = default;
    flat_iterator(flat_iterator const &) = default;
    flat_iterator(flat_iterator &&) = default;
    flat_iterator(Convert const &c) : underlying(c.underlying) {}
    flat_iterator(Convert &&c) : underlying(std::move(c.underlying)) {}
    flat_iterator(It const &underlying) : underlying(underlying) {}
    flat_iterator(It &&underlying) : underlying(std::move(underlying)) {}

    flat_iterator &operator=(flat_iterator const &u) = default;
    flat_iterator &operator=(flat_iterator &&u) = default;
    flat_iterator &operator=(It const &u) {
        this->underlying = u;
        return *this;
    }
    flat_iterator &operator=(It &&u) {
        this->underlying = std::move(u);
        return *this;
    }

    reference operator*() const { return *underlying; }
    pointer operator->() const { return std::addressof(*underlying); }

    flat_iterator &operator++() {
        ++this->underlying;
        return *this;
    }
    flat_iterator operator++(int) {
        flat_iterator it = *this;
        ++this->underlying;
        return it;
    }

    flat_iterator &operator--() {
        --this->underlying;
        return *this;
    }
    flat_iterator operator--(int) {
        flat_iterator it = *this;
        --this->underlying;
        return it;
    }

    flat_iterator &operator+=(difference_type d) {
        this->underlying += d;
        return *this;
    }
    flat_iterator &operator-=(difference_type d) {
        this->underlying -= d;
        return *this;
    }

    flat_iterator operator+(difference_type d) const {
        return this->underlying + d;
    }
    flat_iterator operator-(difference_type d) const {
        return this->underlying - d;
    }

    difference_type operator-(flat_iterator const &o) const {
        return this->underlying - o.underlying;
    }

    reference operator[](difference_type d) const { return *(*this + d); }

    auto operator==(flat_iterator const &o) const {
        using namespace std::rel_ops;
        return this->underlying == o.underlying;
    }
    auto operator!=(flat_iterator const &o) const {
        using namespace std::rel_ops;
        return this->underlying != o.underlying;
    }
    auto operator<(flat_iterator const &o) const {
        return this->underlying < o.underlying;
    }
    auto operator<=(flat_iterator const &o) const {
        return this->underlying <= o.underlying;
    }
    auto operator>(flat_iterator const &o) const {
        return this->underlying > o.underlying;
    }
    auto operator>=(flat_iterator const &o) const {
        return this->underlying >= o.underlying;
    }

    It underlying;
};

template <typename Pair, typename Compare = std::less<void>,
          typename TransparentKey = void>
struct first_compare {
    first_compare(const Compare &comp) : compare(comp) {}

    bool operator()(Pair const &lhs, Pair const &rhs) const {
        return compare.get()(lhs.first, rhs.first);
    }

    bool operator()(typename Pair::first_type const &lhs,
                    Pair const &rhs) const {
        return compare.get()(lhs, rhs.first);
    }

    bool operator()(Pair const &lhs,
                    typename Pair::first_type const &rhs) const {
        return compare.get()(lhs.first, rhs);
    }

    template <typename Key>
    bool operator()(transparent_key_t<Key> const &lhs, Pair const &rhs) const {
        return compare.get()(lhs.get(), rhs.first);
    }

    template <typename Key>
    bool operator()(transparent_key_t<Key> const &lhs,
                    typename Pair::first_type const &rhs) const {
        return compare.get()(lhs.get(), rhs);
    }

    template <typename Key>
    bool operator()(Pair const &lhs, transparent_key_t<Key> const &rhs) const {
        return compare.get()(lhs.first, rhs.get());
    }

    template <typename Key>
    bool operator()(typename Pair::first_type const &lhs,
                    transparent_key_t<Key> const &rhs) const {
        return compare.get()(lhs, rhs.get());
    }

    std::reference_wrapper<const Compare> compare;
};

template <typename D, typename Key, typename Container, typename Compare,
          typename = void>
class flat_container_base {
#include "container_traits.hpp"
    D const *self() const { return static_cast<D const *>(this); }
    D *self() { return static_cast<D *>(this); }

public:
    using key_compare = Compare;
    const key_compare &key_comp() const { return self()->comp; }

    // Iterators

    const_iterator cbegin() const
        noexcept(noexcept(std::declval<D>().container.cbegin())) {
        return self()->container.cbegin();
    }
    const_iterator begin() const
        noexcept(noexcept(std::declval<D>().container.begin())) {
        return self()->container.begin();
    }
    iterator begin() noexcept(noexcept(std::declval<D>().container.begin())) {
        return self()->container.begin();
    }

    const_iterator cend() const
        noexcept(noexcept(std::declval<D>().container.cend())) {
        return self()->container.cend();
    }
    const_iterator end() const
        noexcept(noexcept(std::declval<D>().container.end())) {
        return self()->container.end();
    }
    iterator end() noexcept(noexcept(std::declval<D>().container.end())) {
        return self()->container.end();
    }

    const_reverse_iterator crbegin() const
        noexcept(noexcept(std::declval<D>().container.crbegin())) {
        return self()->container.crbegin();
    }
    const_reverse_iterator rbegin() const
        noexcept(noexcept(std::declval<D>().container.rbegin())) {
        return self()->container.rbegin();
    }
    reverse_iterator rbegin() noexcept(
        noexcept(std::declval<D>().container.rbegin())) {
        return self()->container.rbegin();
    }

    const_reverse_iterator crend() const
        noexcept(noexcept(std::declval<D>().container.crend())) {
        return self()->container.crend();
    }
    const_reverse_iterator rend() const
        noexcept(noexcept(std::declval<D>().container.rend())) {
        return self()->container.rend();
    }
    reverse_iterator rend() noexcept(
        noexcept(std::declval<D>().container.rend())) {
        return self()->container.rend();
    }

    // Capacity

    bool empty() const noexcept(noexcept(std::declval<D>().container.empty())) {
        return self()->container.empty();
    }

    size_type size() const
        noexcept(noexcept(std::declval<D>().container.size())) {
        return self()->container.size();
    }

    // Modifiers

    iterator insert(const_iterator hint, value_type const &value) {
        return self()->insert(value).first;
    }

    iterator insert(const_iterator hint, value_type &&value) {
        return self()->insert(std::move(value)).first;
    }

    template <class InputIt>
    void insert(InputIt first, InputIt last) {
        for (InputIt it = first; it != last; ++it) self()->insert(*it);
    }

    void insert(std::initializer_list<value_type> ilist) {
        self()->insert(ilist.begin(), ilist.end());
    }

    void insert(std::initializer_list<value_type> ilist, delay_sort_t d) {
        self()->insert(ilist.begin(), ilist.end(), d);
    }

    template <typename... Args>
    auto emplace(Args &&...args) {
        return self()->insert(value_type(std::forward<Args>(args)...));
    }

    template <typename... Args>
    auto emplace_hint(const_iterator hint, Args &&...args) {
        return self()->insert(value_type(std::forward<Args>(args)...));
    }

    iterator erase(const_iterator pos) noexcept(
        noexcept(std::declval<D>().container.erase(pos.underlying))) {
        return self()->container.erase(pos.underlying);
    }

    iterator erase(const_iterator first, const_iterator last) noexcept(noexcept(
        std::declval<D>().container.erase(first.underlying, last.underlying))) {
        return self()->container.erase(first.underlying, last.underlying);
    }

    void clear() noexcept(noexcept(std::declval<D>().container.clear())) {
        self()->container.clear();
    }

    void swap(D &other) noexcept(D::has_noexcept_swap()) {
        using std::swap;
        swap(self()->container, other.container);
    }

    // Lookup

    const_iterator find(key_type const &key) const {
        const_iterator it = self()->lower_bound(key);
        if (it == self()->end() || self()->value_comp()(key, *it))
            return self()->end();
        return it;
    }

    iterator find(key_type const &key) {
        iterator it = self()->lower_bound(key);
        if (it == self()->end() || self()->value_comp()(key, *it))
            return self()->end();
        return it;
    }

    const_iterator lower_bound(key_type const &key) const {
        return std::lower_bound(self()->begin(), self()->end(), key,
                                self()->value_comp());
    }

    iterator lower_bound(key_type const &key) {
        return std::lower_bound(self()->begin(), self()->end(), key,
                                self()->value_comp());
    }

    const_iterator upper_bound(key_type const &key) const {
        return std::upper_bound(self()->begin(), self()->end(), key,
                                self()->value_comp());
    }

    iterator upper_bound(key_type const &key) {
        return std::upper_bound(self()->begin(), self()->end(), key,
                                self()->value_comp());
    }

    std::pair<const_iterator, const_iterator> equal_range(
        key_type const &key) const {
        return std::equal_range<const_iterator>(self()->begin(), self()->end(),
                                                key, self()->value_comp());
    }

    std::pair<iterator, iterator> equal_range(key_type const &key) {
        return std::equal_range<iterator>(self()->begin(), self()->end(), key,
                                          self()->value_comp());
    }

private:
    static constexpr bool has_noexcept_swap() {
        using std::swap;
        return noexcept(swap(*static_cast<Container *>(nullptr),
                             *static_cast<Container *>(nullptr)));
    }

protected:
    template <class InputIt>
    void ds_insert_(InputIt first, InputIt last) {
        size_type const i = self()->size();
        for (InputIt it = first; it != last; ++it)
            self()->container.push_back(*it);
        std::sort(self()->container.begin() + i, self()->container.end(),
                  self()->value_comp());
        std::inplace_merge(self()->container.begin(),
                           self()->container.begin() + i,
                           self()->container.end());
        // Note: Not calling unique here. Do it in the caller.
    }
};

template <typename D, typename Key, typename Container, typename Compare>
class flat_container_base<D, Key, Container, Compare,
                          std::void_t<typename Compare::is_transparent>>
    : public flat_container_base<D, Key, Container, Compare, int> {
#include "container_traits.hpp"
    D const *self() const { return static_cast<D const *>(this); }
    D *self() { return static_cast<D *>(this); }
    using B = flat_container_base<D, Key, Container, Compare, int>;

public:
    using B::equal_range;
    using B::find;
    using B::insert;
    using B::lower_bound;
    using B::upper_bound;

    // Modifiers

    template <class P>
    iterator insert(const_iterator hint, P &&value) {
        return insert(std::forward<P>(value)).first;
    }

    // Lookup

    template <typename K>
    const_iterator find(K const &key) const {
        const_iterator it = self()->lower_bound(key);
        if (it == self()->end() || self()->value_comp()(std::ref(key), *it))
            return self()->end();
        return it;
    }

    template <typename K>
    iterator find(K const &key) {
        iterator it = self()->lower_bound(key);
        if (it == self()->end() || self()->value_comp()(std::ref(key), *it))
            return self()->end();
        return it;
    }

    template <typename K>
    const_iterator lower_bound(K const &key) const {
        return std::lower_bound(self()->begin(), self()->end(), std::ref(key),
                                self()->value_comp());
    }

    template <typename K>
    iterator lower_bound(K const &key) {
        return std::lower_bound(self()->begin(), self()->end(), std::ref(key),
                                self()->value_comp());
    }

    template <typename K>
    const_iterator upper_bound(K const &key) const {
        return std::upper_bound(self()->begin(), self()->end(), std::ref(key),
                                self()->value_comp());
    }

    template <typename K>
    iterator upper_bound(K const &key) {
        return std::upper_bound(self()->begin(), self()->end(), std::ref(key),
                                self()->value_comp());
    }

    template <typename K>
    std::pair<const_iterator, const_iterator> equal_range(K const &key) const {
        return std::equal_range<const_iterator>(self()->begin(), self()->end(),
                                                std::ref(key),
                                                self()->value_comp());
    }

    template <typename K>
    std::pair<iterator, iterator> equal_range(K const &key) {
        return std::equal_range<iterator>(self()->begin(), self()->end(),
                                          std::ref(key), self()->value_comp());
    }
};

}  // namespace impl
}  // namespace fc

#endif
