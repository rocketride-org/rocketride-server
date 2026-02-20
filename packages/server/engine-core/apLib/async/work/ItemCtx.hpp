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

// The item context represents the shared state held in the
// work manage, and referenced by the work item object
class ItemCtx : public RunCtx,
                public ChildOf<Executor>,
                public SharedFromThis<ItemCtx> {
public:
    // Default log level
    _const auto LogLevel = Lvl::Work;

    // Friend the work executor so it is able to execute us
    friend class Executor;

    // Construct a work
    ItemCtx(Executor &executor, Location location, Text name,
            Callback &&cb) noexcept
        : ChildOf<Executor>(executor),
          RunCtx(location, name),
          m_callback(_mv(cb)) {
        LOGTL(m_location, "Constructed");
    }

    // Common lock interface calls back into the executor to lock, we
    // keep a very simple lock model to avoid complex lock ordering
    // problems
    auto lock() const noexcept { return parent().lock(); }

    // Render this work as a string
    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        if (m_state == ItemState::Complete)
            return _tsb(buff, name(), " (", m_state, ") ", error());
        return _tsb(buff, name(), " (", m_state, ")");
    }

    // Waits for an item state to occur
    template <bool Invert = false>
    Error waitState(ItemState state,
                    Opt<time::Duration> maxWait = {}) noexcept {
        auto guard = lock();
        if constexpr (Invert)
            return APERRT(
                m_cond.wait(guard, [&] { return m_state != state; }, maxWait));
        else
            return APERRT(
                m_cond.wait(guard, [&] { return m_state == state; }, maxWait));
    }

    // Gets the current task state
    auto state() const noexcept { return m_state; }

    // Joins on the work item until its marked complete, callback
    // is reset releasing any held objects
    Error join(Opt<time::Duration> maxWait = {}, bool clearCb = true) noexcept {
        auto guard = lock();
        if (auto ccode = waitState(ItemState::Complete, maxWait)) return ccode;
        if (clearCb) m_callback.release();
        return m_ccode;
    }

    // Stops and blocks until completed
    Error stop() noexcept {
        cancel();
        return waitState<true>(ItemState::Execute);
    }

    // Gets the result, joins first
    template <typename ResultT>
    ErrorOr<ResultT> result() noexcept {
        if (auto ccode = join(NullOpt, false)) return ccode;
        if (m_ccode) {
            m_callback.release();
            return m_ccode;
        }
        return m_callback.result<ResultT>();
    }

    // State checkers
    auto completed() const noexcept {
        auto guard = lock();
        return m_state == ItemState::Complete;
    }

    auto submitted(bool includeExecuting = true) const noexcept {
        auto guard = lock();
        return (m_state == ItemState::Execute && includeExecuting) ||
               m_state == ItemState::Submit;
    }

    auto executing(bool includePending = true) const noexcept {
        auto guard = lock();
        return (m_state == ItemState::Submit && includePending) ||
               m_state == ItemState::Execute;
    }

    template <typename Predicate>
    auto wait(async::MutexLock::Guard &guard, Predicate &&pred,
              Opt<time::Duration> amount = {}) const noexcept {
        return m_cond.wait(guard, amount, std::forward<Predicate>(pred),
                           amount);
    }

private:
    // Change the state of this work
    auto setState(ItemState state, Opt<Error> ccode = {}) noexcept {
        auto guard = lock();

        LOGTL(m_location, "Item state change {} => {}", m_state, state);

        m_state = state;
        if (ccode)
            m_ccode = _mv(*ccode);
        else if (state == ItemState::Complete)
            m_ccode = {};

        m_cond.notifyAll(guard);

        return cancelled();
    }

    // Current state of this work
    ItemState m_state = ItemState::Init;

    // Condition for waiting on this work with efficient sleep/wake
    Condition m_cond;

    // This callback object holds the bound arguments, and the callback
    // function that will get executed
    Callback m_callback;
};

}  // namespace ap::async::work
