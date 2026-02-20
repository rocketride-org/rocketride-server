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

// Returns the offset duration this time zone is from UTC, handles
// daylight savings mode by including that offset in the result
// See
// https://docs.microsoft.com/en-us/windows/desktop/api/timezoneapi/ns-timezoneapi-_time_zone_information
inline Duration localZoneOffset() noexcept {
    TIME_ZONE_INFORMATION info = {};

    // Will return the local daylight savings mode, which will tell us
    // what portion fo the stucture we should use
    auto daylightMode = GetTimeZoneInformation(&info);

    switch (daylightMode) {
        case TIME_ZONE_ID_STANDARD:
            return minutes((info.StandardBias + info.Bias));
        case TIME_ZONE_ID_DAYLIGHT:
            return minutes((info.DaylightBias + info.Bias));
        default:  // TIME_ZONE_ID_UNKNOWN:
            return minutes(info.Bias);
    }
}

}  // namespace ap::time
