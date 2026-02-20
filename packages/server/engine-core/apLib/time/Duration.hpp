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

namespace ap::time {

// Import std::chrono components
using std::chrono::duration;
using std::chrono::duration_cast;
using std::chrono::hours;
using std::chrono::microseconds;
using std::chrono::milliseconds;
using std::chrono::minutes;
using std::chrono::nanoseconds;
using std::chrono::seconds;

// This class normalizes all the various type specific durations into
// a non templated typename which can accept any duration.
// It will construct from any duration, and is explicitly castable to any
// duration. Its internal representation is a nanosecond.
class Duration {
public:
    // Each interval declares a suffix, and its multiplier to the next
    // period type, so there are 1000 nanoseconds in a us, there are 60 minutes
    // in an hour etc, with the last entry hosting a zero to indicate its the
    // end
    _const Pair<uint32_t, TextView> Intervals[] = {
        {1000, "ns"}, {1000, "us"}, {1000, "ms"}, {60, "s"},
        {60, "min"},  {24, "h"},    {7, "d"},     {0, "w"},
    };
    _const auto MaxIntervals = sizeof(Intervals) / sizeof(Intervals[0]);

    // Default construction
    Duration() = default;

    // Default assignment/construction
    Duration(const Duration &) = default;
    Duration &operator=(const Duration &) = default;

    // Construct from a chrono duration of any rep and period
    template <typename Rep, typename Period>
    Duration(duration<Rep, Period> duration) noexcept
        : m_ns(duration_cast<nanoseconds>(duration)) {}

    // Construct from a day type
    Duration(date::day days) noexcept
        : m_ns(duration_cast<nanoseconds>(
              hours(static_cast<unsigned>(days) * 24))) {}

    // Convert this duration to some other duration type
    template <typename DurationType>
    auto as() const noexcept {
        return duration_cast<DurationType>(m_ns);
    }

    // Specific duration aliases for ease of syntax
    auto asNanoseconds() const noexcept { return m_ns; }
    auto asMicroseconds() const noexcept {
        return duration_cast<microseconds>(m_ns);
    }
    auto asMilliseconds() const noexcept {
        return duration_cast<milliseconds>(m_ns);
    }
    auto asSeconds() const noexcept { return duration_cast<seconds>(m_ns); }
    auto asMinutes() const noexcept { return duration_cast<minutes>(m_ns); }
    auto asHours() const noexcept { return duration_cast<hours>(m_ns); }
    auto asDays() const noexcept {
        return date::day{_nc<unsigned>(duration_cast<hours>(m_ns).count()) /
                         24};
    }

    // Casting operator to a chrono duration
    template <typename Rep, typename Period>
    operator duration<Rep, Period>() const noexcept {
        return duration_cast<duration<Rep, Period>>(m_ns);
    }

    // Casting operator to a day duration
    template <typename Rep, typename Period>
    operator date::day() const noexcept {
        return asDays();
    }

    // Equality, comparison, arithmetic overloads
    bool operator!=(const Duration &duration) const noexcept {
        return m_ns != duration.m_ns;
    }
    bool operator==(const Duration &duration) const noexcept {
        return m_ns == duration.m_ns;
    }
    Duration operator*(int amount) const noexcept { return m_ns * amount; }
    Duration &operator*=(int value) noexcept {
        m_ns *= value;
        return *this;
    }
    Duration &operator+=(const Duration &duration) noexcept {
        m_ns += duration.m_ns;
        return *this;
    }

    Duration operator+(const Duration &duration) const noexcept {
        auto copy = *this;
        copy += duration;
        return copy;
    }

    Duration &operator-=(const Duration &duration) noexcept {
        m_ns -= duration.m_ns;
        return *this;
    }

    Duration operator-(const Duration &duration) const noexcept {
        auto copy = *this;
        copy -= duration;
        return copy;
    }

    bool operator<(const Duration &duration) const noexcept {
        return m_ns < duration.m_ns;
    }
    bool operator<=(const Duration &duration) const noexcept {
        return m_ns <= duration.m_ns;
    }
    bool operator>(const Duration &duration) const noexcept {
        return m_ns > duration.m_ns;
    }
    bool operator>=(const Duration &duration) const noexcept {
        return m_ns >= duration.m_ns;
    }

    // Explicit boolean cast, returns true if non zero
    explicit operator bool() const noexcept { return m_ns != 0ns; }

    template <typename Buffer>
    Error __toString(Buffer &buf, const FormatOptions &opts) const noexcept;

    template <typename Buffer>
    static Error __fromString(Duration &dur, const Buffer &buf) noexcept;

protected:
    // Lowest interval possible, nanoseconds so we don't lose precision
    nanoseconds m_ns = 0ns;
};

// Support comparisons where a std::chrono::duration is on the left side
// comparison operator

template <typename Rep, typename Period>
inline bool operator<=(const duration<Rep, Period> &lhs,
                       Duration rhs) noexcept {
    return duration_cast<nanoseconds>(lhs) <= rhs.asNanoseconds();
}

template <typename Rep, typename Period>
inline bool operator>=(const duration<Rep, Period> &lhs,
                       Duration rhs) noexcept {
    return duration_cast<nanoseconds>(lhs) >= rhs.asNanoseconds();
}

template <typename Rep, typename Period>
inline bool operator<(const duration<Rep, Period> &lhs, Duration rhs) noexcept {
    return duration_cast<nanoseconds>(lhs) < rhs.asNanoseconds();
}

template <typename Rep, typename Period>
inline bool operator>(const duration<Rep, Period> &lhs, Duration rhs) noexcept {
    return duration_cast<nanoseconds>(lhs) > rhs.asNanoseconds();
}

template <typename Rep, typename Period>
inline bool operator==(const duration<Rep, Period> &lhs,
                       Duration rhs) noexcept {
    return duration_cast<nanoseconds>(lhs) == rhs.asNanoseconds();
}

template <typename Rep, typename Period>
inline bool operator!=(const duration<Rep, Period> &lhs,
                       Duration rhs) noexcept {
    return duration_cast<nanoseconds>(lhs) != rhs.asNanoseconds();
}

}  // namespace ap::time
