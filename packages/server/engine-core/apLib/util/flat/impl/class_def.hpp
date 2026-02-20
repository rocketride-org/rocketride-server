// Copyright Pubby 2016
// Distributed under the Boost Software License, Version 1.0.
// http://www.boost.org/LICENSE_1_0.txt

private:
using D = FLATNAME;
using Key = FLATKEY;

public:
#include "container_traits.hpp"

FLATNAME() = default;
explicit FLATNAME(Compare const& comp) : comp(comp), container() {}

template <class InputIt>
FLATNAME(InputIt first, InputIt last) : FLATNAME() {
    this->insert(first, last);
}

template <class InputIt>
FLATNAME(InputIt first, InputIt last, Compare const& comp) : FLATNAME(comp) {
    this->insert(first, last);
}

template <class InputIt>
FLATNAME(InputIt first, InputIt last, delay_sort_t d) : FLATNAME() {
    this->insert(first, last, d);
}

template <class InputIt>
FLATNAME(InputIt first, InputIt last, Compare const& comp, delay_sort_t d)
    : FLATNAME(comp) {
    this->insert(first, last, d);
}

FLATNAME(FLATNAME const&) = default;
FLATNAME(FLATNAME&&) = default;

FLATNAME(std::initializer_list<value_type> ilist) : FLATNAME() {
    this->insert(ilist);
}

FLATNAME(std::initializer_list<value_type> ilist, delay_sort_t d) : FLATNAME() {
    this->insert(ilist, d);
}

FLATNAME(std::initializer_list<value_type> ilist, Compare const& comp,
         delay_sort_t d)
    : FLATNAME(comp) {
    this->insert(ilist, d);
}

template <typename... Args>
explicit FLATNAME(container_construct_t, Args&&... args)
    : container(std::forward<Args>(args)...), comp() {}

template <typename... Args>
FLATNAME(Compare const& comp, container_construct_t, Args&&... args)
    : container(std::forward<Args>(args)...), comp(comp) {}

FLATNAME& operator=(FLATNAME const&) = default;
FLATNAME& operator=(FLATNAME&&) = default;
FLATNAME& operator=(std::initializer_list<value_type> ilist) {
    this->clear();
    this->insert(ilist);
    return *this;
}

Container container;
Compare comp;

#undef FLATNAME
#undef FLATKEY
