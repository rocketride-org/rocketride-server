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

#include <engLib/eng.h>

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Writes data to the buffer.
//-------------------------------------------------------------------------
Error MemoryBuffer::writeData(InputData &data) noexcept {
    LOGT("writeData", data.size(), "...");

    // Do not process input data if the read thread was completed
    bool isCompleted = false;
    if (auto ccodeValue = m_completeEvent.wait(0ms); ccodeValue.hasCcode())
        return ccodeValue.ccode();
    else
        isCompleted = ccodeValue.value();
    if (isCompleted) {
        LOGT("writeData", "skipped: buffer completed");
        return {};
    }

    auto bufferFull = localfcn() {
        auto guard = m_lock.acquire();
        return m_buffer.size() >= m_readSize;
    };

    // Wait until readData to read the data and release it from the buffer
    while (bufferFull()) {
        LOGT("writeData", "full, waiting for read...");

        size_t eventIdx = 0;
        if (auto eventIdxOr =
                async::Event::waitAny({m_readEvent, m_completeEvent});
            eventIdxOr.hasCcode())
            return eventIdxOr.ccode();
        else
            eventIdx = eventIdxOr.value();

        // Do not process input data if the read thread was completed
        if (eventIdx == 1) {
            LOGT("writeData", "skipped: buffer completed");
            return {};
        }
    }

    {
        // Lock the buffer
        auto guard = m_lock.acquire();

        // Write the data to the buffer
        std::copy(data.begin(), data.end(), std::back_inserter(m_buffer));

        LOGT("writeData", "done");

        // If buffer is full, signal it is ready for reading
        if (m_buffer.size() >= m_readSize) {
            LOGT("writeData", "full, signal to read");
            if (auto ccode = m_writeEvent.set()) return ccode;
        }
    }

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Reads data from the buffer.
//-------------------------------------------------------------------------
ErrorOr<size_t> MemoryBuffer::readData(uint64_t offset,
                                       OutputData &data) noexcept {
    LOGT("readData", data.size(), "...");

    {
        // Lock the buffer
        auto guard = m_lock.acquire();

        // Reading condition changed, writeData may wait, so need to ping the
        // write thread
        if (m_readSize != data.size()) {
            // Set size requested to read
            m_readSize = data.size();

            LOGT("readData", data.size(), "signal to write");

            // Signal the data is gonna be read
            if (auto ccode = m_readEvent.set()) return ccode;
        }
    }

    LOGT("readData", "waiting for write...");

    // Wait until the data written or completed
    if (auto ccode =
            async::Event::waitAny({m_writeEvent, m_completeEvent}).check())
        return ccode;

    {
        // Lock the buffer
        auto guard = m_lock.acquire();

        // The read offset must match the current offset
        if (m_offset != offset)
            return APERR(Ec::OutOfRange, "Read offset", offset,
                         "not maching current offset ", m_offset);

        // Size to read
        size_t readSize = std::min(m_buffer.size(), data.size());

        if (readSize) {
            auto b = m_buffer.begin(), e = b + readSize;

            // Copy the buffer data to the output buffer
            std::copy(b, e, data.begin());

            // Erase the read data from the buffer and update the buffer offset
            m_buffer.erase(b, e);
            m_offset += readSize;

            LOGT("readData", "done,", readSize, "read");
            LOGT("readData", "signal to write");

            // Signal the data has been read
            m_readEvent.set();
        } else {
            LOGT("readData", "done, nothing read");
        }

        return readSize;
    }
}

//-------------------------------------------------------------------------
/// @details
///		Resets the state of the buffer
//-------------------------------------------------------------------------
Error MemoryBuffer::clear() noexcept {
    auto guard = m_lock.acquire();

    m_readSize = 0;
    m_buffer.clear();
    m_size = 0;
    m_offset = 0;

    if (auto ccode = m_readEvent.reset() || m_writeEvent.reset() ||
                     m_completeEvent.reset())
        return ccode;

    LOGT("reset");

    return {};
}

Error MemoryBuffer::setComplete() noexcept {
    LOGT("complete");
    return m_completeEvent.set();
}
}  // namespace engine::store
