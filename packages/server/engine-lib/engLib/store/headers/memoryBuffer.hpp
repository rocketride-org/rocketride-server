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

#include <engLib/eng.h>

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		This class manages an in-memory buffer with FIFO capability
///     and read/write operations performed from different threads.
///     Once the memory is written to the buffer in the writing thread,
///     the next read will erase the read data from the buffer
///     in the reading thread.
//-------------------------------------------------------------------------
class MemoryBuffer : public IBuffer {
public:
    _const auto LogLevel = Lvl::MemoryBuffer;

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    Error writeData(InputData &data) noexcept override;
    ErrorOr<size_t> readData(uint64_t offset,
                             OutputData &data) noexcept override;
    Error clear() noexcept override;
    TextView name() const noexcept { return m_name; }
    size_t size() const noexcept override { return m_size; }
    void setup(TextView name, size_t sz) noexcept {
        m_name = name;
        m_size = sz;
    }
    Error setComplete() noexcept;

    template <typename Buffer>
    void __toString(Buffer &buff) const noexcept;

private:
    //-------------------------------------------------------------------------
    /// @details
    ///		Tika read buffer size
    //-------------------------------------------------------------------------
    size_t m_readSize = 0_mb;

    //-------------------------------------------------------------------------
    /// @details
    ///		Internal data buffer
    //-------------------------------------------------------------------------
    std::deque<Byte> m_buffer;

    //-------------------------------------------------------------------------
    /// @details
    ///		Current offset of data buffer form the beginning of
    ///     the buffered object
    //-------------------------------------------------------------------------
    size_t m_offset = 0;

    //-------------------------------------------------------------------------
    /// @details
    ///		Name of the buffered object.
    //-------------------------------------------------------------------------
    Text m_name;

    //-------------------------------------------------------------------------
    /// @details
    ///		Size of the buffered object.
    //-------------------------------------------------------------------------
    size_t m_size = 0;

    //-------------------------------------------------------------------------
    /// @details
    ///		Lock for accessing internal buffer.
    //-------------------------------------------------------------------------
    async::MutexLock m_lock;

    //-------------------------------------------------------------------------
    /// @details
    ///		Event to signal readData completed.
    //-------------------------------------------------------------------------
    async::Event m_readEvent;

    //-------------------------------------------------------------------------
    /// @details
    ///		Event to signal writeData completed.
    //-------------------------------------------------------------------------
    async::Event m_writeEvent;

    //-------------------------------------------------------------------------
    /// @details
    ///		Event to signal all data completed
    //-------------------------------------------------------------------------
    async::Event m_completeEvent{true};
};

template <typename Buffer>
void MemoryBuffer::__toString(Buffer &buff) const noexcept {
    buff << string::format("MemoryBuffer 0x{,X,16} [{}/{}]",
                           _reCast<uint64_t>(this), m_buffer.size(),
                           m_readSize);
}
}  // namespace engine::store
