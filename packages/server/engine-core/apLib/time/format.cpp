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

#include <apLib/ap.h>

namespace ap::time {

// Formats a date time according to a format specifier
Text formatDateTime(SystemStamp time, const Text &fmt) noexcept {
    return date::format(fmt, floor<seconds>(time));
}

// Parses a date time string
ErrorOr<SystemStamp> parseDateTime(const Text &date, const Text &fmt) noexcept {
    std::istringstream in{date};
    date::sys_time<std::chrono::milliseconds> tp;

    // @@ TODO Temporary workaround for compilation issues after upgrading to VS
    // 2019 16.10 After VS implemented the rest of the C++20 support for
    // std::chrono, VS is failing to compile the Date header due to errors
    // arising from ambiguity between date::from_stream and
    // std::chrono::from_stream.  Rather than use the date::parse wrapper on
    // Windows, we'll call the underlying date::from_stream API explicitly until
    // a better solution can be found.  At some point, the Date library should
    // be unnecessary.  The other alternative is to patch the Date package via a
    // vcpkg overlay to add "date::" everywhere that ambiguity errors occur, but
    // that's messier to maintain.

    // Note that we don't have to use the parse_manip struct for this, but
    // calling date::from_stream with nullptr for the unneeded parameters
    // creates a lot of ambiguity that would require casts to fix
    date::parse_manip ctx{fmt, tp};
    date::from_stream(in, ctx.format_.c_str(), ctx.tp_, ctx.abbrev_,
                      ctx.offset_);
#if 0
	// Old code
	in >> date::parse(fmt, tp);
#endif

    if (in.fail())
        return Error{
            Ec::StringParse, _location, "Failed to parse date time:", date,
            "with format:",  fmt};
    return SystemStamp{tp};
}

}  // namespace ap::time
