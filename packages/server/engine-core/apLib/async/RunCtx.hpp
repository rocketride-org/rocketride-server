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

namespace ap::async {

// The run context is the most basic context that ctxs and work items
// (or anything else that can be 'ran/stopped/cancelled/named') share
class RunCtx {
public:
    // Alias our name as a basic array of bytes
    using Name = Array<char, 127>;

    // Construct and copy the callers name string, without allocating
    RunCtx(Location location, Variant<Name, TextView, Text> name) noexcept
        : m_location(location) {
        setName(name);
    }

    // Access the name of this ctx, this returns a TextView but
    // it is ok since our backing structure will guarantee a null during
    // updates and is stack allocated and part of this instances heap spcae
    // so the result is valid for as long as the therad is alive
    TextView name() const noexcept { return TextView{&m_name.front()}; }

    // Sets a new name, ctx names may change during runtime so
    // we provide an api which copies into the array, always stopping
    // one before the end, so we don't need to bother with a lock since
    // the final character will always be null
    Text setName(Variant<Name, TextView, Text> name) noexcept {
        // Copy the previous name on the heap
        Text prev = this->name();

        // Handle the two caes, either a Name array, or a TextVieww proxy
        std::visit(overloaded{[this](const auto &name) noexcept {
                                  // Always ensure we end in a null by caping
                                  // the copy to - 1 of the size of the name
                                  // array, this allows us to avoid locking when
                                  // accessing the name. Just sometimes you may
                                  // get a partial name if the name was being
                                  // replaced once in a while but ctx names are
                                  // always used for debugging and not
                                  // production anyway
                                  _copyTo(
                                      m_name, name,
                                      std::min(name.size(), m_name.size() - 1));
                              },
                              [this](Name name) noexcept {
                                  // Direct assignment
                                  m_name = name;
                              }},
                   name);
        return prev;
    }

    // Cancels this ctx
    auto cancel(bool val = true) noexcept { m_cancelled = val; }

    // Checks if this context is cancelled
    auto cancelled() const noexcept { return m_cancelled.load(); }

    // Access the location
    auto location() const noexcept { return m_location; }

    // Fetch the final run code
    auto error() const noexcept { return m_ccode; }

    // Pop the current run context off the run stack
    auto pop() noexcept {
        auto ctx = m_stack.top();
        m_stack.pop();
        if (m_stack.empty())
            setCurrentThreadName(name());
        else
            setCurrentThreadName(m_stack.top()->name());
        return ctx;
    }

    // Push another run context onto the top of the context stack
    auto push(RunCtx *ctx) noexcept {
        setCurrentThreadName(ctx->name());
        m_stack.push(ctx);
        return ctx;
    }

    // Returns current context, may be top of the context stack,or
    // this one if the stack is empty
    auto current() noexcept {
        if (m_stack.empty()) return this;
        return m_stack.top();
    }

protected:
    // If the ctx failed for some reason during running by throwing
    Error m_ccode;

    // Name holds a non heap allocated copy of the ctx name
    Name m_name = {};

    // Atomic cancel flag, set by other ctxs to cancel this ctx
    Atomic<bool> m_cancelled = {};

    // Location where this ctx was born from
    Location m_location;

    // Stack of layered context
    std::stack<RunCtx *> m_stack;
};

}  // namespace ap::async
