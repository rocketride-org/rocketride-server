// Copyright Pubby 2016
// Distributed under the Boost Software License, Version 1.0.
// http://www.boost.org/LICENSE_1_0.txt

using container_type = Container;
using key_type = Key;
using size_type = typename container_type::size_type;
using difference_type = typename container_type::difference_type;
using value_type = typename container_type::value_type;
using iterator = impl::flat_iterator<
    typename container_type::iterator,
    impl::dummy_iterator<typename container_type::iterator>>;
using const_iterator =
    impl::flat_iterator<typename container_type::const_iterator, iterator>;
using reverse_iterator = impl::flat_iterator<
    typename container_type::reverse_iterator,
    impl::dummy_iterator<typename container_type::reverse_iterator>>;
using const_reverse_iterator =
    impl::flat_iterator<typename container_type::const_reverse_iterator,
                        reverse_iterator>;
