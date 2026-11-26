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

namespace engine::index::db {

//---------------------------------------------------------------------
/// @details
///		WordDocBucketArray is a particular implementation of
///     BucketArrayBase abstract class. It indexes values by WordId and
///     stores DocIds associated with given WordId. Consider it as
///     flat replacement for map.
//---------------------------------------------------------------------
class WordDocBucketArray : public ap::memory::BucketArrayBase<WordId, DocId> {
public:
    //---------------------------------------------------------
    // Constructor
    //---------------------------------------------------------
    WordDocBucketArray(ap::memory::memory_resource *allocator) noexcept
        : BucketArrayBase(allocator) {}

    //---------------------------------------------------------
    // Destructor
    //---------------------------------------------------------
    ~WordDocBucketArray() noexcept {
        for (size_t i = 0; i < getBucketElementsCount(); ++i) {
            if (m_mainBlock[i]) delete[] m_mainBlock[i];
        }
    }

    //---------------------------------------------------------
    /// @details
    ///	    Puts new value into container if and only if it is not
    ///     there yet. It is guaranteed that doc ids will come in
    ///     ascending order and we need to put only unique doc ids
    ///     it is enough to check just the last element of
    ///     container to make a decision if adding new doc id
    ///     there or not.
    ///	@param[in]	index
    ///		Index of word to associate data with
    ///	@param[in]	data
    ///		Document id that needs to be associated with word index
    //---------------------------------------------------------

    void put(WordId index, DocId data) noexcept override {
        ASSERT(m_resourseAllocator);
        ASSERT(index >= 0);

        size_t bucket = index / getBucketElementsCount();
        size_t offset = index % getBucketElementsCount();

        if (!m_mainBlock[bucket] || !m_mainBlock[bucket][offset] ||
            m_mainBlock[bucket][offset].last->data != data) {
            if (!m_mainBlock[bucket]) {  // lazy init of secondary page
                auto bytesCount =
                    sizeof(SecondaryBlock) * getBucketElementsCount();
                SecondaryBlock *block = new SecondaryBlock
                    [getBucketElementsCount()];  // do it from regular memory
                                                 // because of pretty big size
                                                 // allocating here
                memset(block, 0, bytesCount);
                m_mainBlock[bucket] = block;
            }

            SlistNode *docWordIdElement =
                _reCast<SlistNode *>(m_resourseAllocator->allocate(
                    sizeof(SlistNode), nodeAlignment));
            docWordIdElement->data = data;
            docWordIdElement->pNext = nullptr;

            if (!m_mainBlock[bucket]
                            [offset]) {  // adding first element into slist
                m_mainBlock[bucket][offset].first = docWordIdElement;
                m_mainBlock[bucket][offset].last = docWordIdElement;
            } else {  // adding new element into existing list
                m_mainBlock[bucket][offset].last->pNext = docWordIdElement;
                m_mainBlock[bucket][offset].last = docWordIdElement;
            }
        }
    }

private:
    const uint16_t nodeAlignment =
        1;  // singly-linked list nodes alignment inside slabs
};
}  // namespace engine::index::db
