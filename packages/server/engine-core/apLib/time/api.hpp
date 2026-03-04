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

namespace ap::time {

// Returns the current time with either Precise or System clocks. A precise
// clock will have a higher granularity then seconds, where the system clock
// will simply count seconds. Precise should be used for any timing operation,
// utc for date/point in time calculations.
template <Clock::Type ClockType = Clock::Type::PRECISE>
inline auto now() noexcept {
    // Use full precision for the precise clocks
    if constexpr (ClockType == Clock::Type::PRECISE)
        return Clock::Precise::now();
    else {
        // Cap the system clock as second granularity so our comparisons don't
        // incorrectly compare
        return Clock::System::from_time_t(
            Clock::System::to_time_t(Clock::System::now()));
    }
}

// Returns a time stamp of now
template <typename T>
inline T nowSystem() noexcept {
    auto sysStamp = now<Clock::Type::SYSTEM>();
    if constexpr (traits::IsSameTypeV<T, SystemStamp>)
        return sysStamp;
    else
        return _tr<T>(sysStamp);
}

// Returns a time stamp of now adjusted for the local time zone offset
template <typename T>
inline T nowLocal() noexcept {
    auto utc = nowSystem();
    auto sinceEpoch =
        time::Duration(utc.time_since_epoch()) - localZoneOffset();
    auto sysStamp = Clock::System::from_time_t(
        sinceEpoch.template as<time::seconds>().count());
    if constexpr (traits::IsSameTypeV<T, SystemStamp>)
        return sysStamp;
    else
        return _tr<T>(sysStamp);
}

// Returns a time point using a high precision clock, which amounts to
// nanoseconds since epoch, this is the time point to use for timing
// operations
inline PreciseStamp nowPrecise() noexcept {
    return now<Clock::Type::PRECISE>();
}

// Converts a stamp to a time_t, seconds since epoch. Since time_t is just
// defined as a integral type its best not to use it in templates implicitly
// hence this explicit toTimeT api.
template <typename T>
inline time_t toTimeT(T stamp) noexcept {
    if constexpr (traits::IsSameTypeV<T, SystemStamp>)
        return Clock::System::to_time_t(stamp);
    else
        return Clock::System::to_time_t(_tr<SystemStamp>(stamp));
}

// Converts a stamp from a time_t, seconds since epoch. Since time_t is just
// defined as a integral type its best not to use it in templates implicitly
// hence this explicit fromTimeT api.
template <typename T>
inline T fromTimeT(time_t stamp) noexcept {
    if constexpr (traits::IsSameTypeV<T, SystemStamp>)
        return Clock::System::from_time_t(stamp);
    else
        return _tr<T>(Clock::System::from_time_t(stamp));
}

}  // namespace ap::time
