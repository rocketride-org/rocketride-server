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

// Map clocks to a virtual namespace of allowed types
struct Clock {
    // Make an enum which maps back to these types as our time point template
    // type
    enum class Type {
        PRECISE,
        SYSTEM,
    };

    // These map to the actual clock types in the standard
    using Precise = std::chrono::high_resolution_clock;
    using System = std::chrono::system_clock;
    using Steady = std::chrono::steady_clock;
};

// Alias a point in time template, which is effectively the stamp class
template <typename ClockType>
using TimePoint = std::chrono::time_point<ClockType>;

// Define our two time points:
//	 SystemStamp - second resolution, usable with calendar logic
//	 PreciseStamp - nanosecond resolution, timing only
using SystemStamp = TimePoint<std::chrono::system_clock>;
using PreciseStamp = TimePoint<std::chrono::high_resolution_clock>;

// Define default date time formats
_const auto DEF_FMT = "%m/%d/%Y %H:%M:%S";
_const auto ISO_8601_DATE_TIME_FMT = "%FT%TZ";
_const auto ISO_8601_DATE_FMT = "%FT";

// Alias the std::tm structure, breaks out the date time into fields
typedef struct std::tm TmInfo;

}  // namespace ap::time
