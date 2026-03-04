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

// Compare two tm info structires with < operator
inline bool operator<(const TmInfo &lhs, const TmInfo &rhs) noexcept {
    if (lhs.tm_year < rhs.tm_year) return true;
    if (lhs.tm_yday < rhs.tm_yday) return true;
    if (lhs.tm_hour < rhs.tm_hour) return true;
    if (lhs.tm_isdst < rhs.tm_isdst) return true;
    if (lhs.tm_min < rhs.tm_min) return true;
    if (lhs.tm_sec < rhs.tm_sec) return true;
    return false;
}

// Subtract a duration to a system stamp
inline SystemStamp operator-(const SystemStamp &stamp,
                             const Duration &duration) noexcept {
    return stamp - duration.asMicroseconds();
}

// Add a duration to a system stamp
inline SystemStamp operator+(const SystemStamp &stamp,
                             const Duration &duration) noexcept {
    return stamp + duration.asMicroseconds();
}

// Compare a system stamp to a duration
inline bool operator<=(const SystemStamp &stamp, const Duration &dur) noexcept {
    return Duration(stamp.time_since_epoch()) <= dur;
}

// Compare a system stamp to a duration
inline bool operator<(const SystemStamp &stamp, const Duration &dur) noexcept {
    return Duration(stamp.time_since_epoch()) < dur;
}

// Compare a system stamp to a duration
inline bool operator>=(const SystemStamp &stamp, const Duration &dur) noexcept {
    return Duration(stamp.time_since_epoch()) >= dur;
}

// Compare a system stamp to a duration
inline bool operator>(const SystemStamp &stamp, const Duration &dur) noexcept {
    return Duration(stamp.time_since_epoch()) > dur;
}

}  // namespace ap::time
