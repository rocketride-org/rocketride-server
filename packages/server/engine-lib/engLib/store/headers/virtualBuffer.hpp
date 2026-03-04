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

#include <engLib/store/headers/iBuffer.hpp>

namespace engine::store {
using namespace ap;
//-------------------------------------------------------------------------
/// @details
///		This class manages an in-memory buffer with an overflow capability
///		to store additional data. The memory buffer/file work together
///		to create a seamless set of data
///	@returns
///		Error
//-------------------------------------------------------------------------
class VirtualBuffer : public IBuffer {
public:
    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    explicit VirtualBuffer(const file::Path &overflowDir) noexcept;
    ~VirtualBuffer() noexcept;

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    Error writeData(InputData &data) noexcept override;
    ErrorOr<size_t> readData(uint64_t offset,
                             OutputData &data) noexcept override;
    Error clear() noexcept override;
    size_t size() const noexcept override { return m_dataSize; }

private:
    //-----------------------------------------------------------------
    // Privates
    //-----------------------------------------------------------------
    Error createOverflow() noexcept;
    Error destroyOverflow() noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///     Size of the memory part of the buffer. The first part of
    ///     the buffer (this much) is kept in memory
    //-----------------------------------------------------------------
    size_t m_bufferSize = 5_mb;

    //-----------------------------------------------------------------
    /// @details
    ///     Total data size of the data contained in the buffer
    //-----------------------------------------------------------------
    size_t m_dataSize = 0;

    //-----------------------------------------------------------------
    /// @details
    ///     Ptr to the allocated memory buffer
    //-----------------------------------------------------------------
    Byte *m_pBuffer = nullptr;

    //-----------------------------------------------------------------
    /// @details
    ///     Have we opened the over file?
    //-----------------------------------------------------------------
    bool m_isOverflowOpen = false;

    //-----------------------------------------------------------------
    /// @details
    ///     The fixed path to the overflow file -- contains all data
    ///     beyonf m_bufferSize
    //-----------------------------------------------------------------
    file::Path m_overflowPath;

    //-----------------------------------------------------------------
    /// @details
    ///     Stream containing the overflow
    //-----------------------------------------------------------------
    file::FileStream m_overflowStream;
};
}  // namespace engine::store
