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

#include <vector>
#include <memory>
#include <cassert>

namespace ap::memory {

/**
 * Interface for data supplier that is going to be used with paginated vector.
 * @tparam Type
 */
template <typename Type>
class IPaginatedVectorDataSupplier {
public:
    using value_type = Type;

public:
    virtual ~IPaginatedVectorDataSupplier() {};

public:
    // interface
    virtual bool empty() const noexcept = 0;
    virtual size_t size() const noexcept = 0;
    virtual bool loadPage(size_t pageSize, size_t pageNumber, Type *data) = 0;
};

/**
 * Implementation of the paginated vector.
 * This implementation defines strictly necessary functions of vector.
 * This implementation does not define the functions that modify contains of the
 * vector (like `clear`, `insert`, `push_back` and others). This function that
 * usually returns object by reference are returning value in this
 * implementation.
 * @tparam Type
 */
template <typename Type, typename Allocator = std::allocator<Type>>
class PaginatedVector {
public:
    using value_type = Type;
    using reference = value_type &;
    using const_reference = const value_type &;
    using vector_type = typename std::vector<Type, Allocator>;
    using size_type = typename vector_type::size_type;

public:
    /**
     * Forward iterator
     */
    class iterator
        : public std::iterator<std::random_access_iterator_tag, Type, size_t> {
    public:
        explicit iterator(const PaginatedVector<Type, Allocator> *owner,
                          size_t offset)
            : m_owner(owner), m_offset(offset) {}
        iterator(const iterator &rhs) = default;
        iterator(iterator &&rhs) = default;
        iterator &operator=(const iterator &rhs) = default;
        iterator &operator=(iterator &&rhs) = default;

        // dereference
        value_type operator*() const { return m_owner->operator[](m_offset); }
        // increment
        iterator &operator++() {
            ++m_offset;
            return *this;
        }
        iterator operator++(int) {
            iterator it = *this;
            ++m_offset;
            return it;
        }
        // decrement
        iterator &operator--() {
            --m_offset;
            return *this;
        }
        iterator operator--(int) {
            iterator it = *this;
            --m_offset;
            return it;
        }
        // inplace modifiers
        iterator operator+=(size_t delta) {
            m_offset += delta;
            return *this;
        }
        iterator operator-=(size_t delta) {
            m_offset -= delta;
            return *this;
        }
        // arithmetic
        iterator operator+(size_t delta) const {
            return iterator(m_owner, m_offset + delta);
        }
        iterator operator-(size_t delta) const {
            return iterator(m_owner, m_offset - delta);
        }
        ptrdiff_t operator-(const iterator &it2) const {
            return this->m_offset - it2.m_offset;
        }

        // logical operators
        // logical operators doesn't take into consideration owner
        bool operator==(const iterator &r) const {
            return m_offset == r.m_offset;
        }
        bool operator!=(const iterator &r) const {
            return m_offset != r.m_offset;
        }
        bool operator<(const iterator &r) const {
            return m_offset < r.m_offset;
        }
        bool operator<=(const iterator &r) const {
            return m_offset <= r.m_offset;
        }

    private:
        const PaginatedVector<Type, Allocator> *m_owner;
        size_t m_offset;
    };
    /**
     * Reverse iterator
     */
    class reverse_iterator
        : public std::iterator<std::random_access_iterator_tag, Type, size_t> {
    public:
        explicit reverse_iterator(const PaginatedVector<Type, Allocator> *owner,
                                  size_t offset)
            : m_owner(owner), m_offset(offset) {}
        reverse_iterator(const reverse_iterator &rhs) = default;
        reverse_iterator(reverse_iterator &&rhs) = default;
        reverse_iterator &operator=(const reverse_iterator &rhs) = default;
        reverse_iterator &operator=(reverse_iterator &&rhs) = default;

        // link with forward iterator
        iterator base() const { return iterator(m_owner, m_offset); }
        // dereference
        value_type operator*() const {
            return m_owner->operator[](m_offset - 1);
        }
        // increment
        reverse_iterator &operator++() {
            --m_offset;
            return *this;
        }
        reverse_iterator operator++(int) {
            reverse_iterator it = *this;
            --m_offset;
            return it;
        }
        // decrement
        reverse_iterator &operator--() {
            ++m_offset;
            return *this;
        }
        reverse_iterator operator--(int) {
            reverse_iterator it = *this;
            ++m_offset;
            return it;
        }
        // inplace modifiers
        reverse_iterator operator+=(size_t delta) {
            m_offset -= delta;
            return *this;
        }
        reverse_iterator operator-=(size_t delta) {
            m_offset += delta;
            return *this;
        }
        // arithmetic
        reverse_iterator operator-(size_t delta) const {
            return reverse_iterator(m_owner, m_offset + delta);
        }
        reverse_iterator operator+(size_t delta) const {
            return reverse_iterator(m_owner, m_offset - delta);
        }
        ptrdiff_t operator-(const reverse_iterator &it2) const {
            return it2.m_offset - this->m_offset;
        }

        // logical operators
        // logical operators doesn't take into consideration owner
        bool operator==(const reverse_iterator &r) const {
            return m_offset == r.m_offset;
        }
        bool operator!=(const reverse_iterator &r) const {
            return m_offset != r.m_offset;
        }
        bool operator<(const reverse_iterator &r) const {
            return m_offset > r.m_offset;
        }
        bool operator<=(const reverse_iterator &r) const {
            return m_offset >= r.m_offset;
        }

    private:
        const PaginatedVector<Type, Allocator> *m_owner;
        size_t m_offset;
    };

public:
    // rule of five
    PaginatedVector()
        : m_pageSize{0},
          m_loadPageCount{0},
          m_currentPage{0},
          m_dataSupplier{0} {}
    PaginatedVector(
        size_t pageSize,
        std::shared_ptr<IPaginatedVectorDataSupplier<Type>> dataSupplier)
        : m_pageSize{pageSize},
          m_loadPageCount{0},
          m_currentPage{0},
          m_dataSupplier{dataSupplier} {
        assert(m_pageSize > 0);
        m_vector.resize(m_pageSize);
        if (m_dataSupplier->loadPage(m_pageSize, m_currentPage,
                                     m_vector.data()))
            ++m_loadPageCount;
    }
    PaginatedVector(const PaginatedVector<Type, Allocator> &) = default;
    PaginatedVector(PaginatedVector<Type, Allocator> &&) = default;
    PaginatedVector &operator=(PaginatedVector<Type, Allocator> &) = default;
    PaginatedVector &operator=(PaginatedVector<Type, Allocator> &&) = default;

public:
    /**
     * Returns page size (number of elements per page)
     * @return page size
     */
    size_t pageSize() const noexcept { return m_pageSize; }

    /**
     * Checks if underlying data supplier has no data, and returns true
     * otherwise
     * @return `true` if vector is empty, `false` otherwise
     */
    bool empty() const noexcept { return m_dataSupplier->empty(); }

    /**
     * Returns size of underlying data supplier (number of elements)
     * @return Size of  underlying data supplier
     */
    size_t size() const noexcept { return m_dataSupplier->size(); }

    /**
     * Returns forward iterator to the first element to the underlying data
     * supplier
     * @return forward iterator to the first element to the underlying data
     * supplier
     */
    iterator begin() const noexcept { return iterator{this, 0}; }
    /**
     * Returns forward iterator to the element following the last element in the
     * underlying data supplier.
     * @return forward iterator to the element following the last element in the
     * underlying data supplier.
     */
    iterator end() const noexcept {
        return iterator(this, m_dataSupplier->size());
    }
    /**
     * @return reverse iterator to the first element to the underlying data
     * supplier. Returns reverse iterator to the first element to the underlying
     * data supplier.
     */
    reverse_iterator rbegin() const noexcept {
        return reverse_iterator{this, m_dataSupplier->size()};
    }
    /**
     * Returns reverse iterator to the element following the last element in the
     * underlying data supplier.
     * @return reverse iterator to the element following the last element in the
     * underlying data supplier.
     */
    reverse_iterator rend() const noexcept { return reverse_iterator{this, 0}; }

    /**
     * Return value by index.
     * The behavior is the same as in `std::vector`: it doesn't check out of
     * index. The return value is returned by value (and not by reference in
     * comparison to the `std::vector`) to avoid undefined behavior which could
     * be caused by page reload.
     * @param index
     * @return  value (not a reference as the reference may be invalidated
     */
    value_type operator[](size_t index) const {
        ensureLoadPage(index);
        return m_vector[index % m_pageSize];
    }

public:
    /**
     * Auxiliary function. Returns how many time the page actually was loaded.
     * @return Number of page loads
     */
    size_t getPageLoadCount() const { return m_loadPageCount; }

private:
    bool ensureLoadPage(size_t index) const {
        size_t pageToLoad = index / m_pageSize;
        if (pageToLoad != m_currentPage &&
            m_dataSupplier->loadPage(m_pageSize, pageToLoad, m_vector.data())) {
            m_currentPage = pageToLoad;
            ++m_loadPageCount;
            return true;
        }
        return false;
    }

private:
    // Page size (number of element per page). Page size is set on
    // initialization of PaginatedVector, and couldn't be modified later All
    // pages are of the same size, except the last one - it could be smaller.
    size_t m_pageSize;
    // How many times pages were loaded/switched. It could be used for
    // optimization if needed.
    mutable size_t m_loadPageCount;
    // Current page
    mutable size_t m_currentPage;
    // The vector with size of `m_pageSize` where all elements are present.
    // This vector is refreshed from the data supplier if element outside of the
    // current page was requested.
    mutable vector_type m_vector;
    // Data supplier
    std::shared_ptr<IPaginatedVectorDataSupplier<Type>> m_dataSupplier;
};

}  // namespace ap::memory
