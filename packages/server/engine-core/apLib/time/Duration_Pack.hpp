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

// Convert a duration to a string
template <typename Buffer>
inline Error Duration::__toString(Buffer &buf,
                                  const FormatOptions &opts) const noexcept {
    if (opts.hex()) return _tsbo(buf, opts, m_ns.count());

    auto ns =
        _nc<long double>(time::duration_cast<time::nanoseconds>(m_ns).count());

    size_t i = 0;
    for (; i < MaxIntervals; i++) {
        if (!Intervals[i].first) break;
        if (std::abs(ns) < Intervals[i].first) break;
        ns /= Intervals[i].first;
    }
    i = std::min(MaxIntervals - 1, i);

    ns = util::adjustPrecision(ns);

    return _tsbo(buf, Format::GROUP, ns, Intervals[i].second);
}

// Convert a string to a duration
template <typename Buffer>
inline Error Duration::__fromString(Duration &dur, const Buffer &buf) noexcept {
    auto str = buf.toString();

    // Given a found interval index, this function will multiply it by all of
    // its leading intervals to come up with the appropviate value for the
    // interval
    auto convertInterval = [&](auto i) noexcept -> Error {
        // Convert the number portion
        auto res = _fsc<long double>(buf);
        if (!res) return _mv(res.ccode());

        // Now multiply it by all its leading intervals
        auto count = *res;
        for (signed i2 = _nc<signed>(i) - 1; i2 >= 0; i2--) {
            auto &interval = Intervals[i2];
            if (interval.first == 0) break;
            count = _nc<long double>(count * interval.first);
        }

        dur = nanoseconds(_nc<nanoseconds::rep>(count));
        return {};
    };

    // Look for a matching postfix
    for (size_t i = 0; i < MaxIntervals; i++) {
        if (string::endsWith(str, Intervals[i].second, false))
            return convertInterval(i);
    }

    // No prefix, assume seconds
    return convertInterval(3);
}

}  // namespace ap::time
