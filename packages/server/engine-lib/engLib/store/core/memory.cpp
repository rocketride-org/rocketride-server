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

#ifdef CLASSIFY_DLL_EXPORT
// When building as part of classify wrapper DLL, use apLib directly (no
// engLib/Python deps)
#include <apLib/ap.h>
#include <cstdlib>  // For malloc/free/realloc
#include <cstring>  // For memset

// Setup namespace aliasing like eng.h does - required for engLib headers
namespace engine {
using namespace ap;
}
namespace engine::store {
using namespace ap;
}

#include <engLib/store/headers/memory.hpp>
#else
// Normal engLib build uses the master header
#include <engLib/eng.h>
#endif

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Allocate memory
///	@param[in]	size
///		Size of block to allocate
///	@param[out]	ppBlockIn
///		Receives a ptr to the block
///	@returns
///		Error
//-------------------------------------------------------------------------
Error Memory::alloc(size_t size, void *ppBlockIn) {
    void **ppBlock = (void **)ppBlockIn;
    void *pBlock;

    // Allocate the block
    pBlock = ::malloc(size);

    // If out of memory, say so
    if (!pBlock)
        return APERR(Ec::OutOfMemory, _location,
                     "Out of memory allocating {} bytes", size);

    // Clear it
    memset(pBlock, 0, size);

    // Return the block
    *ppBlock = pBlock;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Release memory
///	@param[in,out]	ppBlockIn
///		Releases a block or memory. Note it is a ptr to a ptr to the block of
///		memory. If the content of the ptr is null, there is no block. On return,
///		the ptr will be reset
///	@returns
///		Error
//-------------------------------------------------------------------------
Error Memory::release(void *ppBlockIn) {
    // Free it
    void **ppBlock = (void **)ppBlockIn;

    // If it is not allocated
    if (!*ppBlock) return {};

    // Release it
    ::free(*ppBlock);

    // Set the ptr to null
    *ppBlock = nullptr;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Resize a block of memory
///	@param[in]	size
///		Size of block to allocate
///	@param[in,out]	ppBlockIn
///		Block of memory to resize. Note it is a ptr to a ptr to the block of
///		memory. If the content of the ptr is null, there is no block. On return,
///		the ptr will be reset
///	@returns
///		Error
//-------------------------------------------------------------------------
Error Memory::resize(size_t size, void *ppBlockIn) {
    void **ppBlock = (void **)ppBlockIn;
    void *pBlock;

    // Reallocate the block
    pBlock = ::realloc(*ppBlock, size);

    // If out of memory, say so
    if (!pBlock)
        return APERR(Ec::OutOfMemory, _location,
                     "Out of memory allocating {} bytes", size);

    // Return the block
    *ppBlock = pBlock;
    return {};
}
}  // namespace engine::store