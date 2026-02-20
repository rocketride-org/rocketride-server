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

namespace ap {
// Construct the Error with a numeric code and optional location
template <typename Code>
inline Error::Error(Code errorCode, Location location) noexcept
    : m_code(make_error_code(errorCode)), m_location(location) {
    if (log::isLevelEnabled(Lvl::StackTrace)) m_trace.emplace(dev::Backtrace());

    static_assert(!traits::IsSameTypeV<Code, Error>);
}

// Construct the Error with a numeric code, a location, and
// a variable number of arguments to be formatted with
// a format specification string
template <typename Code, typename... Msg>
inline Error::Error(Code errorCode, Location location, Msg &&...msg) noexcept
    : m_code(make_error_code(errorCode)), m_location(location) {
    if (log::isLevelEnabled(Lvl::StackTrace)) m_trace.emplace(dev::Backtrace());

    static_assert(!traits::IsSameTypeV<Code, Error>);
    m_message = _tso({Format::RTTIOK | Format::LOGGING, 0, ' '},
                     std::forward<Msg>(msg)...);
}

template <typename Json>
inline void Error::__toJson(Json &val) const noexcept {
    val["code"] = _ts(code());
    val["message"] = message();
    val["location"] = _ts(location());
    if (m_trace) val["trace"] = _ts(*m_trace);
    if (m_chain) val["chain"] = _tj(*m_chain);
}

// String render method, picked up by the convert apis
template <typename Buffer>
inline void Error::__toString(Buffer &buff, FormatOptions opts) const noexcept {
    toString(*this, buff, opts);
}

// Renders the error chain recursively, first call will print a header
// for the chain log, the rest don't
template <typename Buffer>
inline void Error::toString(const Error &ccode, Buffer &buff,
                            FormatOptions opts, uint32_t index) noexcept {
    if (!ccode) {
        _tsbo(buff, opts, Color::Green, ccode.code(), Color::Reset);
        return;
    }

    _tsbo(buff, opts, Color::Red, ccode.code().message(),
          _ts(" (", ccode.code(), ") "), ccode.location());

    // If there is a message associated with it, output it
    if (auto msg = ccode.message()) {
        _tsb(buff, "\nMessage: ",
             string::replace(string::replace(msg, "\n", ""), "  ", " "));
    }

    // Same with location
    if (ccode.m_trace) _tsb(buff, "\n", ccode.m_trace);

    // On chaining, be verbose when Error level is enabled, otherwise just
    // log the root one as the cause
    if (ccode.m_chain) {
        if (index++)
            _tsb(buff, "\n[", index, "] ");
        else
            _tsb(buff, "\n");
        _tsb(buff, "Caused by:\n");
        if (log::isLevelEnabled(Lvl::Error))
            toString(*ccode.m_chain, buff, opts, index);
        else
            _tsbo(buff, opts, ccode.root());
    }

    if (!opts.noColors()) buff << Color::Reset;
}

// Makes a chain
inline void Error::makeChain(const Error &chain) noexcept {
    if (!chain) return;

    if (chain.m_location != m_location) m_chain = makeShared<Error>(chain);
}

inline void Error::makeChain(Error &&chain) noexcept {
    if (!chain) return;

    if (chain.m_location != m_location)
        m_chain = makeShared<Error>(_mv(chain));
    else
        chain.reset();
}

}  // namespace ap
