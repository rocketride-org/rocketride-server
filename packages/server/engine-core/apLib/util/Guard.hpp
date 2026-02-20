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

namespace ap::util {

// Winner of the 'Most useful class' award 5 years and counting,
// this incredibly simple but useful class just does stuff on destruction,
// (and optionally on construction) allowing you to avoid using gotos ;)
template <typename CallType>
class Guard {
public:
    static_assert(std::is_invocable_v<CallType>, "CallType must be invocable");

    // @description
    // Eliminate default construction and copying/assignment
    Guard() noexcept = delete;
    Guard(const Guard &) = delete;
    Guard &operator=(const Guard &) = delete;

    // @description
    // Move operator/constructor - efficiently move the scope around
    Guard(Guard &&scope) noexcept { operator=(_mv(scope)); }

    Guard &operator=(Guard &&scope) noexcept {
        m_post = _mv(scope.m_post);
        scope.m_post = {};
        return *this;
    }

    // @description
    // Post version, will call the invocable type when the scope destructs
    Guard(CallType &&post) noexcept : m_post(std::forward<CallType>(post)) {}

    // @description
    // Pre/post version, executes the first invocable as part of construction
    // then stashes post for call on destruction
    template <typename PreCallType>
    Guard(PreCallType &&pre, CallType &&post) noexcept(false)
        : Guard(_mv(post)) {
        std::invoke(_mv(pre));
    }

    // @description
    // Upon destruction, the callback is executed
    ~Guard() noexcept { exec(); }

    // @description
    // Manually execute the guard.
    void exec() noexcept {
        if (!m_post) return;

        // Prevent any throws from the destructor
        try {
            std::invoke(m_post);
        } catch (...) {
        }

        m_post = {};
    }

    // @description
    // Cancel the guard.
    void cancel() noexcept { m_post = {}; }

protected:
    Function<void()> m_post;
};

// Concrete specialization suitable for member variables, etc.
using Scope = Guard<std::function<void()>>;

}  // namespace ap::util
