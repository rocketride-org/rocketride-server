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

namespace engine::monitor {
//-------------------------------------------------------------------------
// Counts is a generic class that tracks counts completed/faled, etc
// these counts can be anything, they are job specific
//-------------------------------------------------------------------------
class Counts {
public:
    //-------------------------------------------------------------
    // Keeps track of current objects
    //-------------------------------------------------------------
    struct CountObject {
        Text path;
        size_t size;
    };

    //-------------------------------------------------------------
    /// @details
    ///		Set the counts
    ///	@param[in]	other
    ///		The counts to set this to
    //-------------------------------------------------------------
    Counts& operator=(const Counts& other) noexcept;

    //-------------------------------------------------------------
    /// @details
    ///		Add two counts together
    ///	@param[in]	other
    ///		The count to add
    //-------------------------------------------------------------
    Counts& operator+=(const Counts& other) noexcept;

    //-------------------------------------------------------------
    /// @details
    ///		Is the rate timer stated?
    //-------------------------------------------------------------
    bool started() const noexcept { return m_rate.started(); }

    //-------------------------------------------------------------
    /// @details
    ///		Get the rate
    //-------------------------------------------------------------
    decltype(auto) rate() const noexcept { return m_rate.stats(); }

    //-------------------------------------------------------------
    /// @details
    ///		Get the overall elapsed time of the task
    //-------------------------------------------------------------
    time::Duration elapsed() noexcept { return m_rate.stats().runTime; }

    //-------------------------------------------------------------
    /// @details
    ///		Lock the counts - we are updating
    //-------------------------------------------------------------
    async::MutexLock::Guard lock() const noexcept { return m_rate.lock(); }

    //-------------------------------------------------------------
    /// @details
    ///		Add to the failed counts
    //-------------------------------------------------------------
    Counts& addFailed(Count count, Size size = 0) noexcept {
        return addFailed({count, size});
    }

    //-------------------------------------------------------------
    /// @details
    ///		Add to the completed counts
    //-------------------------------------------------------------
    Counts& addCompleted(Count count, Size size = 0) noexcept {
        return addCompleted({count, size});
    }

    //-------------------------------------------------------------
    /// @details
    ///		Add to the completed counts
    //-------------------------------------------------------------
    Counts& addWords(Count count, Size size = 0) noexcept {
        return addWords({count, size});
    }

    //-------------------------------------------------------------
    /// @details
    ///		Determine if anything has been set
    //-------------------------------------------------------------
    explicit operator bool() const noexcept { return _cast<bool>(m_total); }

    //-------------------------------------------------------------
    /// @details
    ///		Get the total number of items
    //-------------------------------------------------------------
    auto total() const noexcept {
        auto guard = lock();
        return m_total;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Get the number of completed items
    //-------------------------------------------------------------
    auto completed() const noexcept {
        auto guard = lock();
        return m_rate.counts();
    }

    //-------------------------------------------------------------
    /// @details
    ///		Get the number of failed items
    //-------------------------------------------------------------
    auto failed() const noexcept {
        auto guard = lock();
        return m_failed;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Get the number of words processed
    //-------------------------------------------------------------
    auto words() const noexcept {
        auto guard = lock();
        return m_words;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Get the total number of items
    //-------------------------------------------------------------
    const CountObject* currentObject() const noexcept {
        auto guard = lock();
        if (m_objects.empty())
            return nullptr;
        else
            return &m_objects.back();
    }

    //-------------------------------------------------------------
    /// @details
    ///		Determines if the count is updated
    //-------------------------------------------------------------
    bool haveCountsBeenUpdated() { return m_updateCounts; }

    //-------------------------------------------------------------
    /// @details
    ///		Determines if the curent object is updated
    //-------------------------------------------------------------
    bool hasObjectBeenUpdated() { return m_updateObject; }

    //-------------------------------------------------------------
    /// @details
    ///		Resets the updated flag
    //-------------------------------------------------------------
    void resetCountsUpdated() { m_updateCounts = false; }

    //-------------------------------------------------------------
    /// @details
    ///		Resets the updated flag
    //-------------------------------------------------------------
    void resetObjectUpdated() { m_updateObject = false; }

    //-------------------------------------------------------------
    /// @details
    ///		Reset all the counts
    //-------------------------------------------------------------
    void reset() noexcept {
        m_failed.reset();
        m_total.reset();
        m_words.reset();
        m_rate.reset();
        m_updateCounts = {};
        m_updateObject = {};
    }

    //-------------------------------------------------------------
    // Public API
    //-------------------------------------------------------------
    void startCounters() noexcept;
    Counts& addCompleted(CountSize counts) noexcept;
    Counts& addFailed(CountSize counts) noexcept;
    Counts& addWords(CountSize counts) noexcept;
    void beginObject(TextView path, uint64_t size) noexcept;
    void endObject(TextView path) noexcept;
    void beginObject(Entry& object) noexcept;
    void endObject(Entry& object) noexcept;
    void stopCounters() noexcept;

    void __toJson(json::Value& val) const noexcept;
    template <typename Buffer>
    void __toString(Buffer& buff, FormatOptions opts) const noexcept;

private:
    //-------------------------------------------------------------
    /// @details
    ///		Do we need to update the counts
    //-------------------------------------------------------------
    bool m_updateCounts = {};

    //-------------------------------------------------------------
    /// @details
    ///		Do we need to update the object
    //-------------------------------------------------------------
    bool m_updateObject = {};

    //-------------------------------------------------------------
    /// @details
    ///		The total number of items
    //-------------------------------------------------------------
    CountSize m_total;

    //-------------------------------------------------------------
    /// @details
    ///		The total number of items failed
    //-------------------------------------------------------------
    CountSize m_failed;

    //-------------------------------------------------------------
    /// @details
    ///		The total number of words processed
    //-------------------------------------------------------------
    CountSize m_words;

    //-------------------------------------------------------------
    /// @details
    ///		The total number of words processed
    //-------------------------------------------------------------
    std::list<CountObject> m_objects;

    //-------------------------------------------------------------
    /// @details
    ///		We use rate for completed
    //-------------------------------------------------------------
    mutable util::Throughput m_rate{200, 5s};
};
}  // namespace engine::monitor
