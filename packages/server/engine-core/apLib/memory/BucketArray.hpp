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

namespace ap {
namespace memory {
using memory_resource = boost::container::pmr::memory_resource;

//---------------------------------------------------------------------
/// @details
///		BucketArrayBase defines the base class accessing elements in
///		memory via two arithmetical operations based on IndexType provided.
///
///		Main block is indexed by index / BUCKET_ELEMENTS_COUNT
///		Secondary blocks are indexed by index % BUCKET_ELEMENTS_COUNT
///
///		It allocates main block with BUCKET_ELEMENTS_COUNT and each
///		secondary block will be allocated on first attempt to put
///		something into it. Each secondary block will also have
///		BUCKET_ELEMENTS_COUNT elements inside it.
///
///		Elements inside secondary blocks are stored in singly-linked list
///		which eliminates memory fragmentation, is able to use slab
///		allocations and stores values with minimal memory overhead
///
///		More details: https://rocketride.atlassian.net/browse/APPLAT-3295
///
///		In order to use this class one must subclass from it,
///		instantiate base class with correct template parameters and
///		implement the logics of adding elements into bucket array
///		inside method
///
///		virtual void put(IndexType index, StoreType data) noexcept;
///
//---------------------------------------------------------------------
template <typename IndexType = uint32_t, typename StoreType = uint32_t,
          size_t BUCKET_ELEMENTS_COUNT = 256000u>
class BucketArrayBase {
public:
    struct SecondaryBlock;
    class BucketArrayIterator;

    //---------------------------------------------------------
    // Constructor creates main block
    //---------------------------------------------------------
    BucketArrayBase(memory_resource* allocator) noexcept
        : m_resourseAllocator(allocator) {
        ASSERT(m_resourseAllocator);

        // allocate main block on creation
        // do it from regular memory because of pretty big size allocating here
        auto bytesCount = sizeof(SecondaryBlock*) * BUCKET_ELEMENTS_COUNT;
        m_mainBlock = new SecondaryBlock*[BUCKET_ELEMENTS_COUNT];
        memset(m_mainBlock, 0, bytesCount);
    }

    //---------------------------------------------------------
    // Destructor deletes main block
    //---------------------------------------------------------
    virtual ~BucketArrayBase() noexcept { delete[] m_mainBlock; }

    //---------------------------------------------------------
    /// @details
    ///		This method encapsulates the logics of adding
    ///		new elements into bucket array. Descendants must
    ///		implement this method.
    ///	@param[in]	index
    ///		Index to associate data with
    ///	@param[in]	data
    ///		Data data that needs to be associated with index
    //---------------------------------------------------------
    virtual void put(IndexType index, StoreType data) noexcept = 0;

    //---------------------------------------------------------
    ///	@returns
    ///		Returns the number of elements inside this
    ///		bucket array
    //---------------------------------------------------------
    inline size_t getBucketElementsCount() const noexcept {
        return BUCKET_ELEMENTS_COUNT;
    }

    //---------------------------------------------------------
    ///	@returns
    ///		Returns pointer to secondary array by requested index
    ///	@param[in]	index
    ///		Index of object
    //---------------------------------------------------------
    const SecondaryBlock* get(IndexType index) const noexcept {
        ASSERT(index >= 0);

        size_t bucket = index / BUCKET_ELEMENTS_COUNT;
        size_t offset = index % BUCKET_ELEMENTS_COUNT;

        if (!m_mainBlock[bucket] || !m_mainBlock[bucket][offset])
            return nullptr;

        return &m_mainBlock[bucket][offset];
    }

    //---------------------------------------------------------
    ///	@returns
    ///		Returns the iterator object for bucket array
    //---------------------------------------------------------
    BucketArrayIterator enumerate() const noexcept {
        for (size_t i = 0; i < BUCKET_ELEMENTS_COUNT; ++i) {
            if (!m_mainBlock[i]) continue;

            for (size_t j = 0; j < BUCKET_ELEMENTS_COUNT; ++j) {
                if (m_mainBlock[i][j]) {
                    return BucketArrayIterator(m_mainBlock, i, j);
                }
            }
        }

        return BucketArrayIterator(nullptr, 0, 0);
    }

    //---------------------------------------------------------
    ///	@returns
    ///		Returns logest size of all containers inside this bucket array
    //---------------------------------------------------------
    size_t getLongestSize() const noexcept {
        size_t longest = 0;
        size_t curLen = 0;

        for (size_t i = 0; i < BUCKET_ELEMENTS_COUNT; ++i) {
            if (!m_mainBlock[i]) continue;

            for (size_t j = 0; j < BUCKET_ELEMENTS_COUNT; ++j) {
                if (m_mainBlock[i][j]) {
                    SlistNode* var = m_mainBlock[i][j].first;
                    while (var) {
                        ++curLen;
                        var = var->pNext;
                    }

                    longest = std::max(longest, curLen);
                    curLen = 0;
                }
            }
        }
        return longest;
    }

public:
#pragma pack(push, 1)  // pack contents of struct SlistNode to 1-byte alignment
                       // to save some bytes
    struct SlistNode {
        SlistNode* pNext;
        StoreType data;
    };
#pragma pack(pop)

    //---------------------------------------------------------
    /// @details
    ///		Each element in secondary block array stores two pointers
    ///     to first and last nodes of singly-linked list
    //---------------------------------------------------------
    struct SecondaryBlock {
        SlistNode* first;
        SlistNode* last;

        operator bool() const noexcept { return first && last; }
    };

    //---------------------------------------------------------
    /// @details
    ///		BucketArrayIterator is an iterator by elements of
    ///		bucket array
    //---------------------------------------------------------
    class BucketArrayIterator {
    public:
        //---------------------------------------------------------
        // Constructor
        //---------------------------------------------------------
        BucketArrayIterator(SecondaryBlock** mainBlock, size_t i,
                            size_t j) noexcept
            : m_mainBlock(mainBlock), m_i(i), m_j(j) {}

        //---------------------------------------------------------
        /// @details
        ///		Operator to check the state of iterator object
        ///	@returns
        ///		true if iterator is alive and false otherwise
        //---------------------------------------------------------
        operator bool() const noexcept { return m_mainBlock; }

        //---------------------------------------------------------
        ///	@returns
        ///		Pair consisting of index and pointer to secondary
        ///		block under this iterator
        //---------------------------------------------------------
        std::pair<IndexType, const SecondaryBlock*> get() const noexcept {
            IndexType index =
                _cast<IndexType>(m_i * BUCKET_ELEMENTS_COUNT + m_j);

            if (!(*this)) return {index, nullptr};

            return {index, &m_mainBlock[m_i][m_j]};
        }

        //---------------------------------------------------------
        /// @details
        ///		Dereference opertor for convenience
        //---------------------------------------------------------
        auto operator*() const noexcept { return this->get(); }

        //---------------------------------------------------------
        ///	@details
        ///		Advances iterator to the next avalable object in
        ///		bucket array
        ///	@returns
        ///		true if iterator has been advanced successfully
        ///		false otherwise
        //---------------------------------------------------------
        bool next() noexcept {
            if (!(*this)) return false;

            m_j++;  // advance to check next index

            for (size_t i = m_i; i < BUCKET_ELEMENTS_COUNT; ++i) {
                if (!m_mainBlock[i]) continue;

                for (size_t j = m_j; j < BUCKET_ELEMENTS_COUNT; ++j) {
                    if (m_mainBlock[i][j]) {
                        m_i = i;
                        m_j = j;
                        return true;
                    }
                }
                m_j = 0;  // reset index to start over
            }

            m_mainBlock = nullptr;
            return false;
        }

        //---------------------------------------------------------
        /// @details
        ///		Prefix increment operator for convenience
        //---------------------------------------------------------
        BucketArrayIterator& operator++() noexcept {
            this->next();
            return *this;
        }

    private:
        SecondaryBlock** m_mainBlock = nullptr;
        size_t m_i{}, m_j{};
    };

protected:
    memory_resource* m_resourseAllocator =
        nullptr;  // resourse allocator that manages slabs of preallocated
                  // memory
    SecondaryBlock** m_mainBlock =
        nullptr;  // array of pointers to secondary blocks
};

}  // namespace memory
}  // namespace ap
