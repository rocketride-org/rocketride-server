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

#ifdef CLASSIFY_DLL_EXPORT
// When building as part of classify wrapper DLL, use apLib directly (no
// engLib/Python deps)
#include <apLib/ap.h>

// Setup namespace aliasing like eng.h does - required for engLib headers
namespace engine {
using namespace ap;
}
namespace engine::store {
using namespace ap;
}

#include <engLib/headers/types.h>  // For Byte, Dword, etc.
#include <engLib/store/headers/iBuffer.hpp>
#include <engLib/store/headers/virtualBuffer.hpp>
#include <engLib/store/headers/memory.hpp>  // For Memory class

// Bring engine types into engine::store
namespace engine::store {
using engine::Byte;
using engine::Dword;
}  // namespace engine::store
#else
// Normal engLib build uses the master header
#include <engLib/eng.h>
#endif

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		This function will open an overflow file to be used to
///		store data that exceeds our in-memory buffer size
///	@returns
///		Error
//-------------------------------------------------------------------------
Error VirtualBuffer::createOverflow() noexcept {
    // If it's already open, done
    if (m_isOverflowOpen) return {};

    // Create the overflow file in write mode - allows us to read as well
    if (auto ccode = m_overflowStream.open(m_overflowPath, file::Mode::WRITE))
        return ccode;

    // Say the overflow is open now
    m_isOverflowOpen = true;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Pushes data into the "buffer"
///	@returns
///		Error
//-------------------------------------------------------------------------
Error VirtualBuffer::destroyOverflow() noexcept {
    // If we didn't create an overflow file, done
    if (!m_isOverflowOpen) return {};

    // Close it
    m_overflowStream.close();

    // Indicate we no longer have an overflow file
    m_isOverflowOpen = false;

    // And remove it
    file::remove(m_overflowPath);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Resets the buffer - clears all data out of it. We can actuall
///		keep the overflow file if we have one. We will re-use it as
///		needed. If it's too big for further incoming data, oh well,
///		doesn't matter. How much data we have to read is exclusively
///		controlled by m_dataSize
///	@returns
///		Error
//-------------------------------------------------------------------------
Error VirtualBuffer::clear() noexcept {
    m_dataSize = 0;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Pushes data into the "buffer". The location is always at the
///		end - this is not an update type
/// @param[in]	view
///		View of the data (including the size)
///	@returns
///		Error
//-------------------------------------------------------------------------
Error VirtualBuffer::writeData(InputData &input) noexcept {
    // Get the databuffer and size
    Byte *pData = (Byte *)input.data();
    size_t size = input.size();

    // If we have no memory buffer
    if (!m_pBuffer) {
        // Create this on demand
        if (auto ccode = Memory::alloc((Dword)m_bufferSize, &m_pBuffer))
            return ccode;
    }

    // We are starting at offset 0 within the callers buffer
    size_t userOffset = 0;

    // If we have room left in our buffer
    if (m_dataSize < m_bufferSize) {
        // Determine how much we can to write
        auto chunk = m_bufferSize - m_dataSize;

        // If we have more than enough, use the size
        if (chunk > size) chunk = size;

        // Copy over as much as we can
        memcpy(&m_pBuffer[m_dataSize], &pData[userOffset], chunk);

        // Adjust the size we have remaining to copy, the offset
        // within the user buffer where we will continue on
        // to write to disk if needed, and the overall data size
        size -= chunk;
        userOffset += chunk;
        m_dataSize += chunk;
    }

    // If we still have size left to write, we are overflowing
    // into the disk file. We know now that m_dataSize >= m_bufferSize
    if (size) {
        // Compute the offset in the disk file. The first 5mb
        // are store in memory, so 5Mb+1 in the data stream
        // is actually at offset 1 in the disk file
        auto diskOffset = m_dataSize - m_bufferSize;

        // Create a view of the buffer
        InputData bufferView(&pData[userOffset], size);

        // Make sure we have an overflow file open
        if (auto ccode = createOverflow()) return ccode;

        // Write the remaining to the disk
        if (auto ccode = m_overflowStream.write(bufferView, diskOffset))
            return ccode;

        // Adjust the size we are tracking
        m_dataSize += size;
    }
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Reads data from the buffer
///	@returns
///		Error
//-------------------------------------------------------------------------
ErrorOr<size_t> VirtualBuffer::readData(uint64_t offset,
                                        OutputData &output) noexcept {
    // Get the databuffer and size
    Byte *pData = (Byte *)output.data();
    size_t size = output.size();
    size_t sizeRead = 0;

    // If we have no memory buffer, obviously, we do not have
    // anything written to the buffer
    if (!m_pBuffer) return sizeRead;

    // If the offset starts beyond the end of data, 0 bytes
    if (offset > m_dataSize) return sizeRead;

    // Trim down the requested size so it doesn't go past the end
    if (offset + size > m_dataSize) size = m_dataSize - offset;

    // If we trimmed it down and nothing left, done
    if (!size) return sizeRead;

    // We are starting at offset 0 within the callers buffer
    size_t userOffset = 0;

    // Fulfill what we can out of the memory buffer
    if (offset < m_bufferSize) {
        // Determine how much we can fulfill out of the memory buffer
        auto chunk = size;
        if (offset + chunk > m_bufferSize) chunk = m_bufferSize - offset;

        // Copy it to the callers buffer
        memcpy(&pData[userOffset], &m_pBuffer[offset], chunk);

        // Adjust the size we have remaining to copy, the offset
        // within the user buffer where we will continue on and
        // the offset where we will read next
        size -= chunk;
        userOffset += chunk;
        offset += chunk;

        // Keep track of how much we read
        sizeRead += chunk;
    }

    // If we need to read from the disk buffer
    if (size) {
        // Compute the offset in the disk file. The first 5mb
        // are store in memory, so 5Mb+1 in the data stream
        // is actually at offset 1 in the disk file
        auto diskOffset = offset - m_bufferSize;

        // Create a view of the buffer
        OutputData bufferView(&pData[userOffset], size);

        // Write the remaining to the disk
        auto res = m_overflowStream.read(bufferView, diskOffset);

        // Check for a read error
        if (res.hasCcode()) return res.ccode();

        // Adjust how much we are read
        sizeRead += *res;
    }

    // And return how much we read
    return sizeRead;
}

//-------------------------------------------------------------------------
/// @details
///		Constructor - setup the path of the overflow file if needed
/// @param[in] overflowDir
///     Directory where overflow files will be created
//-------------------------------------------------------------------------
VirtualBuffer::VirtualBuffer(const file::Path &overflowDir) noexcept {
    // Format a unique name
    Text name = _fmt("virtual-{}.overflow", (uint64_t)this);

    // Create the path
    m_overflowPath = overflowDir / name;
}

//-------------------------------------------------------------------------
/// @details
///		Destructor - cleanup the memory buffer and the overflow
//-------------------------------------------------------------------------
VirtualBuffer::~VirtualBuffer() noexcept {
    // Shut down the overflow file (remove it)
    destroyOverflow();

    // Release the memory buffer
    if (m_pBuffer) Memory::release(&m_pBuffer);
}
}  // namespace engine::store
