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

// The lock class is a template that wraps a lock in a convenient lock
// api. Its the front end class that provides a lock interface we
// prefer over the bare standard types. The cool thing here however is
// _any_ type that adheres to the BasicLockable concept in the standard
// will work here, for example LockType may be std::mutex, or it may be
// async::Mutex. If you use async::Mutex you get counter, and owner id
// tracking, vs just a basic lock/unlock api in the std::mutex case.
template <typename LockType>
class Lock final {
public:
    // Default construction, creates an instance of LockType
    Lock() noexcept : m_lock{std::in_place_type<LockType>} {}

    // Construct from another lock, causes this lock to share the lock
    // of the passed in lock
    Lock(Lock &lock) noexcept : m_lock(lock) {}

    // Destructor, flags this lock as invalid, causes locks to return nullops
    ~Lock() noexcept {
        m_lock = std::monostate{};
        m_destructed = true;
    }

    // Declare our types
    using Guard = std::unique_lock<LockType>;

    // Alias an enable if template to clean things up, this will
    // enable owner methods below
    template <typename D>
    using EnableIfTracksOwnerId = std::enable_if<LockTraits<D>::Owner>;

    // Alias an enable if template to clean things up, this will
    // enable count methods
    template <typename D>
    using EnableIfTracksCounts = std::enable_if<LockTraits<D>::Count>;

    // Fundamental api
    Guard lock() noexcept {
        ASSERT(!m_destructed);
        return _visit(
            overloaded{
                [this](Ref<Lock> &lock) noexcept { return lock.get().lock(); },
                [this](LockType &lock) noexcept { return Guard{lock}; },
                [this](std::monostate) noexcept { return Guard{}; }},
            m_lock);
    }
    auto acquire() noexcept { return lock(); }

    // Enabled if OwnerId is provided
    template <typename T = LockType, typename = EnableIfTracksOwnerId<T>>
    auto ownedByMe() noexcept {
        ASSERT(!m_destructed);
        return _visit(
            overloaded{[this](const Ref<Lock> &lock) noexcept {
                           return lock.get().ownerId() == threadId();
                       },
                       [this](const LockType &lock) noexcept {
                           return lock.ownerId() == threadId();
                       },
                       [this](std::monostate) noexcept { return true; }},
            m_lock);
    }

    template <typename T = LockType, typename = EnableIfTracksOwnerId<T>>
    Tid ownerId() const noexcept {
        ASSERT(!m_destructed);
        return _visit(
            overloaded{[this](const Ref<Lock> &lock) noexcept {
                           return lock.get().ownerId();
                       },
                       [this](const LockType &lock) noexcept {
                           return lock.ownerId();
                       },
                       [this](std::monostate) noexcept { return Tid{}; }},
            m_lock);
    }

    template <typename T = LockType, typename = EnableIfTracksCounts<T>>
    size_t count() const noexcept {
        ASSERT(!m_destructed);
        return _visit(
            overloaded{[this](const Ref<Lock> &lock) noexcept -> size_t {
                           return lock.get().count();
                       },
                       [this](const LockType &lock) noexcept -> size_t {
                           return lock.count();
                       },
                       [this](std::monostate) noexcept -> size_t { return 0; }},
            m_lock);
    }

protected:
    // The internally held lock instance, or a reference to the peer
    // lock
    Variant<std::monostate, Ref<Lock>, LockType> m_lock;
    bool m_destructed = false;
};

}  // namespace ap::async
