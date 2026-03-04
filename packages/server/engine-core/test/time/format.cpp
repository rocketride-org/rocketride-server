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

#include "test.h"

TEST_CASE("time::formatDateTime") {
    using namespace ap::time;

    // Must be set as UTC for test portability
    _const SystemStamp timestamp =
        date::sys_days(2020y / 1 / 1) + 12h + 34min + 56s;
    LOG(Test, "Using timestamp: 12:34:56 PM, January 1st, 2020");

    auto validate = [&](auto formatStr, auto expected, bool reversible = true) {
        // Format and verify that it's the expected value
        const auto formatted = formatDateTime(timestamp, formatStr);
        LOG(Test, "Formatted '{}' as '{}'", formatStr, formatted);
        REQUIRE(formatted == expected);

        // Parse and verify is equivalent to original (if reversible)
        const auto parsed = *parseDateTime(formatted, formatStr);
        if (reversible) REQUIRE(parsed == timestamp);
    };

    validate(DEF_FMT, "01/01/2020 12:34:56"_tv);
    validate(ISO_8601_DATE_TIME_FMT, "2020-01-01T12:34:56Z"_tv);
    // The formatted date-only version can't be converted back to the timestamp
    validate(ISO_8601_DATE_FMT, "2020-01-01T"_tv, false);
}