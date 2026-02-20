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

namespace ap::async::work {

// A work item holds a callback, and represents a pending piece of work
// which is outstanding in a work executor
class Item final {
public:
    // Allow default construction
    Item() = default;

    // Construct an item from a context
    Item(ItemCtxPtr ctx) noexcept : m_ctx(_mv(ctx)) {}

    // Atomically cancels the work item in the executor, will block
    // if actively executing
    ~Item() noexcept {
        if (m_ctx) m_ctx->stop();
    }

    // Move construction and assignment
    Item(Item &&item) noexcept { operator=(_mv(item)); }

    Item &operator=(Item &&item) noexcept {
        if (this == &item) return *this;
        if (m_ctx) m_ctx->stop();
        m_ctx = _mv(item.m_ctx);
        return *this;
    }

    // No copying allowed
    Item(const Item &) = delete;
    Item &operator=(const Item &) = delete;

    // Boolean cast, equates to true if context is valid
    explicit operator bool() const noexcept { return _cast<bool>(m_ctx); }

    // Deref operator forwards our context ptr
    auto operator->() const noexcept {
        ASSERT(m_ctx);
        return m_ctx.operator->();
    }

    auto operator->() noexcept {
        ASSERT(m_ctx);
        return m_ctx.operator->();
    }

    // Detaches this item from the context
    auto detach() noexcept { return _mv(m_ctx); }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        return _tsb(buff, m_ctx);
    }

private:
    // Shared state between this instance and the work executor
    ItemCtxPtr m_ctx;
};

}  // namespace ap::async::work
