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

namespace ap {

// Transform a System to a SystemStamp (useful for when you want to
// adjust its bias)
inline void __transform(time::SystemStamp &stamp,
                        const time::SystemStamp &dateStamp,
                        time::Duration offset) noexcept {
    time::Duration durationOffset =
        dateStamp.time_since_epoch() + offset.template as<time::seconds>();
    stamp =
        time::Clock::System::from_time_t(durationOffset.asSeconds().count());
}

#if ROCKETRIDE_PLAT_WIN
// Transform FILETIME to uint64_t
inline void __transform(const FILETIME &fileTime, uint64_t &qword) noexcept {
    qword = (_cast<uint64_t>(fileTime.dwHighDateTime) << 32) |
            fileTime.dwLowDateTime;
}

// Transform uint64_t to FILETIME
inline void __transform(const uint64_t &qword, FILETIME &fileTime) noexcept {
    fileTime.dwLowDateTime = qword & 0x00000000FFFFFFFF;
    fileTime.dwHighDateTime = qword >> 32;
}
#endif

inline void __transform(const timespec &ts, time::Duration &duration) noexcept {
    using namespace std::chrono;
    duration = duration_cast<nanoseconds>(seconds{ts.tv_sec} +
                                          nanoseconds{ts.tv_nsec});
}

inline void __transform(const time::Duration &duration, timespec &ts) noexcept {
    auto seconds = duration.asSeconds();
    ts.tv_sec = seconds.count();
    auto nanoseconds = (duration - seconds).asNanoseconds();
    ts.tv_nsec = _nc<long>(nanoseconds.count());
};

inline void __transform(const timespec &ts, time::SystemStamp &stamp) noexcept {
    using namespace std::chrono;
    stamp =
        time_point<system_clock, seconds>{_tr<time::Duration>(ts).asSeconds()};
}

inline void __transform(const time::SystemStamp &stamp, timespec &ts) noexcept {
    using namespace std::chrono;
    auto seconds = time_point_cast<std::chrono::seconds>(stamp);
    ts.tv_sec = seconds.time_since_epoch().count();
    ts.tv_nsec = 0;
};

inline void __transform(const timespec &ts,
                        time::PreciseStamp &stamp) noexcept {
    using namespace std::chrono;
    stamp = time_point<high_resolution_clock, nanoseconds>{
        _tr<time::Duration>(ts).asNanoseconds()};
}

inline void __transform(const time::PreciseStamp &stamp,
                        timespec &ts) noexcept {
    using namespace std::chrono;
    auto seconds = time_point_cast<std::chrono::seconds>(stamp);
    ts.tv_sec = _nc<decltype(ts.tv_sec)>(seconds.time_since_epoch().count());
    auto nanoseconds = time_point_cast<std::chrono::nanoseconds>(stamp) -
                       time_point_cast<std::chrono::nanoseconds>(seconds);
    ts.tv_nsec = _nc<decltype(ts.tv_nsec)>(nanoseconds.count());
};

inline void __transform(const timeval &tv, time::Duration &duration) noexcept {
    using namespace std::chrono;
    duration = duration_cast<nanoseconds>(seconds{tv.tv_sec} +
                                          microseconds{tv.tv_usec});
}

inline void __transform(const time::Duration &duration, timeval &tv) noexcept {
    auto seconds = duration.asSeconds();
    tv.tv_sec = _nc<decltype(tv.tv_sec)>(seconds.count());
    auto microseconds = (duration - seconds).asMicroseconds();
    tv.tv_usec = _nc<decltype(tv.tv_usec)>(microseconds.count());
};

inline void __transform(const timeval &tv, time::SystemStamp &stamp) noexcept {
    using namespace std::chrono;
    stamp =
        time_point<system_clock, seconds>{_tr<time::Duration>(tv).asSeconds()};
}

inline void __transform(const time::SystemStamp &stamp, timeval &tv) noexcept {
    using namespace std::chrono;
    auto seconds = time_point_cast<std::chrono::seconds>(stamp);
    tv.tv_sec = _nc<decltype(tv.tv_sec)>(seconds.time_since_epoch().count());
    tv.tv_usec = 0;
};

inline void __transform(const timeval &tv, time::PreciseStamp &stamp) noexcept {
    using namespace std::chrono;
    stamp = time_point<high_resolution_clock, nanoseconds>{
        _tr<time::Duration>(tv).asNanoseconds()};
}

inline void __transform(const time::PreciseStamp &stamp, timeval &tv) noexcept {
    using namespace std::chrono;
    auto seconds = time_point_cast<std::chrono::seconds>(stamp);
    tv.tv_sec = _nc<decltype(tv.tv_sec)>(seconds.time_since_epoch().count());
    auto microseconds = time_point_cast<std::chrono::microseconds>(stamp) -
                        time_point_cast<std::chrono::microseconds>(seconds);
    tv.tv_usec = _nc<decltype(tv.tv_usec)>(microseconds.count());
};

}  // namespace ap
