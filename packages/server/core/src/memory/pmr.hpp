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

#define PmrVector boost::container::pmr::vector
#define PmrMap boost::container::pmr::map
#define PmrSet boost::container::pmr::set
#define PmrMultimap boost::container::pmr::multimap
#define PmrDeque boost::container::pmr::deque

namespace ap {
namespace memory {
using memory_resource = boost::container::pmr::memory_resource;

//---------------------------------------------------------------------
/// @details
///		Define our high level monitonic resource allocator
//---------------------------------------------------------------------
class constant_mbr;
using MonotonicResource = ap::memory::constant_mbr;

//---------------------------------------------------------------------
/// @details
///		Define the allocator
//---------------------------------------------------------------------
template <typename T>
using PolyAllocator = boost::container::pmr::polymorphic_allocator<T>;

//---------------------------------------------------------------------
/// @details
///		Define the polypmorphic allocator that allocates memory in
///		chunks. The strategy is to allocate in one huge chunk, then
///		sub-allocate out of that. This is an allocate-only allocator,
///		with each allocation following the last. Very useful for
///		high speed allocation where freeing memory is not needed
///
///		This is a heavily based on the
///		boost::container::pm::constant_mbr class
//---------------------------------------------------------------------
class constant_mbr : public memory_resource {
private:
    //---------------------------------------------------------
    /// @details
    ///		Define the layout of each chunk
    //---------------------------------------------------------
    struct MemoryChunk {
        MemoryChunk *pNext;
        uint8_t buffer[1];
    };

public:
    //---------------------------------------------------------
    // Constructor/destructor
    //---------------------------------------------------------
    constant_mbr(size_t chunk_size = 0) noexcept {
        // Setup some reasonable defaults
        if (chunk_size < 32 * 1024) chunk_size = 32 * 1024;
        if (chunk_size > 512 * 1024 * 1024) chunk_size = 512 * 1024 * 1024;
        _M_chunk_size = chunk_size;
    }
    virtual ~constant_mbr() { release(); }

    //---------------------------------------------------------
    /// @details
    ///		Disable copy
    //---------------------------------------------------------
    constant_mbr &operator=(const constant_mbr &) = delete;

    //---------------------------------------------------------
    /// @details
    ///		Release all the buffers - clear it and start
    ///		from scratch
    //---------------------------------------------------------
    void release() noexcept {
        if (_M_head) _M_release_buffers();
    }

protected:
    //---------------------------------------------------------
    /// @details
    ///		Perform a sub-allocation
    //---------------------------------------------------------
    void *do_allocate(size_t bytes, size_t alignment) override {
        // Ensures we don't return the same pointer twice.
        if (bytes == 0) bytes = 1;

        // Align the ptr
        void *p = std::align(alignment, bytes, _M_current_buf, _M_avail);

        // If we couldn't align it (due to the fact it
        // is not there, or remaining is too small)
        if (!p) {
            // Allocate a new buffer
            _M_new_buffer(_M_chunk_size);

            // Allign again
            p = std::align(alignment, bytes, _M_current_buf, _M_avail);
        }

        // Adjust it
        _M_current_buf = (char *)_M_current_buf + bytes;
        _M_avail -= bytes;
        return p;
    }

    //---------------------------------------------------------
    /// @details
    ///		Nothing to do as we do not support releasing
    //---------------------------------------------------------
    void do_deallocate(void *, size_t, size_t) override {}

    //---------------------------------------------------------
    /// @details
    ///		Check if two constant_mbr are the same
    //---------------------------------------------------------
    bool do_is_equal(const memory_resource &other) const noexcept override {
        return this == &other;
    }

private:
    //---------------------------------------------------------
    /// @details
    ///		Update _M_current_buf and _M_avail to refer to a
    ///		new buffer with at least the specified size and
    ///		alignment, allocated from upstream.
    //---------------------------------------------------------
    void _M_new_buffer(size_t bytes) {
        // Get a new buffer
        auto p =
            (MemoryChunk *)new uint8_t[offsetof(MemoryChunk, buffer) + bytes];

        // Link the buffer
        p->pNext = _M_head;

        // And save this as the top of the list
        _M_head = p;

        // Setup the curent ptrs and size
        _M_current_buf = p->buffer;
        _M_avail = bytes;
    }

    //---------------------------------------------------------
    /// @details
    ///		Deallocate all buffers obtained from _M_new_buffer
    //---------------------------------------------------------
    void _M_release_buffers() noexcept {
        auto p = _M_head;

        while (p) {
            auto next = p->pNext;
            delete p;
            p = next;
        }

        _M_head = nullptr;
        _M_current_buf = nullptr;
        _M_avail = 0;
    }

    //---------------------------------------------------------
    /// @details
    ///		Linked list of chunks we have allocated
    //---------------------------------------------------------
    MemoryChunk *_M_head = nullptr;

    //---------------------------------------------------------
    /// @details
    ///		Point to the next byte to allocate within the chunk
    //---------------------------------------------------------
    void *_M_current_buf = nullptr;

    //---------------------------------------------------------
    /// @details
    ///		How much is left in this chunk
    //---------------------------------------------------------
    size_t _M_avail = 0;

    //---------------------------------------------------------
    /// @details
    ///		How big each chunk is
    //---------------------------------------------------------
    size_t _M_chunk_size = 32 * 1024 * 1024;
};
}  // namespace memory
}  // namespace ap
