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

namespace ap::async {

// Options to setup the buffers
struct BufferOptions {
    Size bufferSize = 10_mb;
    Size maxIoSize = 256_kb;

    // For our math to work out, we need a non zero buffer size
    // and max io size, max io size should be less then the buffer
    // size, and it should be a factor of the buffer size
    static bool validate(size_t bufferSize, size_t maxIoSize) noexcept {
        return bufferSize && bufferSize <= 1_gb && maxIoSize &&
               maxIoSize <= 1_gb && bufferSize > maxIoSize &&
               (bufferSize % maxIoSize) == 0;
    }

    bool valid() const noexcept { return validate(bufferSize, maxIoSize); }

    auto bufferCount() const noexcept { return bufferSize / maxIoSize; }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "Buffer size:" << bufferSize << "Max IO size:" << maxIoSize;
    }

    bool operator==(const BufferOptions &compare) const noexcept {
        return bufferSize == compare.bufferSize &&
               maxIoSize == compare.maxIoSize;
    }

    bool operator!=(const BufferOptions &compare) const noexcept {
        return !this->operator==(compare);
    }
};

namespace {
struct NullCtx {};
}  // namespace

// Buffers implements a free/used pattern for managing buffering implementations
template <typename DataT, typename AllocT = std::allocator<DataT>,
          typename CtxT = NullCtx>
class Buffers {
public:
    _const auto LogLevel = Lvl::Buffer;
    _const auto HasCtx = !traits::IsSameTypeV<NullCtx, CtxT>;

    using Context = CtxT;
    using DataType = DataT;
    using Data = memory::Data<DataType, AllocT>;
    using DataView = memory::DataView<DataType>;

    // Alias whether a valid user type was defined or not
    template <typename T>
    using IfCtx = std::enable_if_t<T::HasCtx>;

    // Represents a slice of the main buffer
    struct Buffer {
        Buffer(memory::DataView<DataT> data) noexcept : data(data) {}

        Buffer(Buffer &&) = default;
        Buffer &operator=(Buffer &&) = default;

        // Main chunk of memory dedicated to this buffer
        memory::DataView<DataT> data;

        // Cursor into the data, updated as this buffer is used
        memory::DataView<DataT> cursor = {data};

        // Called in writer push, once the writer is done incrementing the
        // cursor the final capped size of the cursor is established with an
        // optional position to be parked at (used during encryption to hide the
        // iv)
        auto resetCursor(Opt<size_t> size = {},
                         Opt<size_t> offset = {}) noexcept {
            // Take a slice of the actual data at teh given offset, capped with
            // the given size
            cursor =
                data.sliceAt(offset.value_or(0),
                             size.value_or(data.size() - offset.value_or(0)));
        }

        explicit operator bool() const noexcept { return _cast<bool>(cursor); }

        auto readerSizeAvail() const noexcept { return cursor.size(); }

        auto writerSizeUsed() const noexcept {
            return data.size() - cursor.size();
        }

        auto writerSizeRemaining() const noexcept {
            return data.size() - writerSizeUsed();
        }

        auto size() const noexcept { return data.size(); }

        Context ctx{};
    };

    Buffers() noexcept = default;

    Buffers(async::MutexLock &lock) noexcept : m_lock(lock) {}

    void reset() noexcept {
        // Clear the queues and re-set the buffers
        m_used.reset();
        m_free.reset();
        m_readerCurrent.reset();
        m_writerCurrent.reset();

        for (auto i = 0; i < m_opts.bufferCount(); i++)
            m_free.push({{&m_data.at(i * m_opts.maxIoSize), m_opts.maxIoSize}});
    }

    decltype(auto) options() const noexcept { return m_opts; }

    Error init(BufferOptions opts) noexcept {
        if (!opts.valid()) return APERRT(Ec::Bug, "Invalid options");

        m_opts = opts;

        m_data.resize(opts.bufferSize);

        m_free.reset();
        m_used.reset();
        m_readerCurrent.reset();
        m_writerCurrent.reset();

        for (auto i = 0; i < m_opts.bufferCount(); i++)
            m_free.push(m_data.sliceAt(i * m_opts.maxIoSize, m_opts.maxIoSize));

        return {};
    }

    Error flush(bool block = true, bool complete = true) noexcept {
        auto guard = lock();

        if (m_writerCurrent) writerPush(_mvOpt(m_writerCurrent), true);

        if (!block) return {};

        if (auto ccode = m_used.flush(complete)) return ccode;

        // Wait for all the buffers to be put back to free this handles
        // the duration of time between the consumer processing a
        // popped used buff
        auto res = m_free.condPush().wait(guard, [&]() noexcept {
            return m_free.size() == m_opts.bufferCount() || cancelled();
        });
        if (!res) return cancelled();
        return APERRT(res, "Failed to flush buffers");
    }

    // Reader push/pop, both use m_readerCurrent to cache
    Error readerPush(Buffer &&buff, bool force = false) noexcept {
        ASSERTD(!m_readerCurrent);

        if (buff.cursor && !force) {
            m_readerCurrent = _mv(buff);
            return {};
        } else {
            // Its a free buffer now so reset the cursor
            buff.resetCursor();
            return m_free.push(_mv(buff));
        }
    }

    ErrorOr<Buffer> readerPop() noexcept {
        auto guard = lock();
        if (m_readerCurrent) return _mvOpt(m_readerCurrent);
        return m_used.pop();
    }

    // Writer push/pop, both use m_writerCurrent to cache
    Error writerPush(Buffer &&buff, bool force = false,
                     Opt<size_t> offset = {}) noexcept {
        auto guard = lock();

        ASSERTD(!m_writerCurrent);

        // If this buffer isn't fully used up yet
        // place it as the current buffer until a flush
        // or another pop used comes in
        if (buff && !force) {
            // An offset can only be honored if force = true
            if (offset && *offset)
                return APERRT(
                    Ec::Bug,
                    "writerPush called with an offset and force = false");

            m_writerCurrent = _mv(buff);
            return {};
        }

        // Buffer fully used (or we are being forced), reset the cursor for the
        // consumer
        buff.resetCursor(buff.writerSizeUsed(), offset);

        return m_used.push(_mv(buff));
    }

    ErrorOr<Buffer> writerPop() noexcept {
        auto guard = lock();

        // If there's a partial one ready grab that
        if (m_writerCurrent) return _mvOpt(m_writerCurrent);

        // No partial fetch from free queue
        return m_free.pop();
    }

    auto complete() noexcept { m_used.complete(); }

    auto cancel(Error ccode) noexcept {
        m_free.cancel(ccode);
        m_used.cancel(_mv(ccode));
        // Return error for chaining
        return ccode;
    }

    auto cancel(Location location) noexcept {
        return cancel({Ec::Cancelled, location});
    }

    Error cancelled() const noexcept {
        return m_free.cancelled() || m_used.cancelled();
    }

    Error completed() const noexcept {
        if (m_free.completed() || m_used.completed())
            return APERR(Ec::Completed, "Buffers completed");
        return {};
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        // Show the buffer usage in bytes/total
        return _tsb(buff, "[", m_opts.maxIoSize * m_used.size(), "/",
                    m_opts.bufferSize, "]");
    }

private:
    // Common lock shared with the two queues of buffers
    mutable async::MutexLock m_lock;

    // Current buffer is when a writerPush is called and the buffer
    // isn't fully consumed, on the next readerPop we'll return it
    // or when a flush is called we will put it on the used queue
    Opt<Buffer> m_readerCurrent, m_writerCurrent;

    // Two queues representing free buffers, that is buffers available
    // to be populated with data, and used buffers, that is buffers
    // ready with data
    async::Queue<Buffer> m_free{m_lock}, m_used{m_lock};

    // Main buffer where all the views reference
    Data m_data;

    // Held options from setup
    BufferOptions m_opts;

    // Common lock api for convenience
    async::MutexLock::Guard lock() const noexcept { return m_lock.acquire(); }
};

}  // namespace ap::async
