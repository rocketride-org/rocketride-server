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

namespace ap::error {

namespace {
inline void postProcess(const Error& ccode, Location location,
                        Opt<Lvl> lvl = {}) noexcept {
    // Not an error; bail
    if (ccode == Ec::NoErr) return;

    // If "Error" logging is enabled or if the error occurred in an enabled
    // channel, log it
    if (log::isLevelEnabled(Lvl::Error) || (lvl && log::isLevelEnabled(*lvl)))
        log::write(location, ccode);

    // If it's the special "Bug" error, log an assertion failure and enter the
    // debugger This behavior can be disabled by calling dev::bugCheck() = false
    if (ccode == Ec::Bug && dev::bugCheck())
        dev::enterDebugger(location, "!!!BUG!!", ccode);
}
}  // namespace

template <typename Code, typename Prefix, typename... Msg>
inline Error makeErrorPrefix(Code&& code, Location location,
                             const Prefix& prefix, Msg&&... msg) noexcept {
    Error ccode{std::forward<Code>(code), location, std::forward<Msg>(msg)...};
    postProcess(ccode, location, prefix.LogLevel);
    return ccode;
}

template <typename Code, typename Level, typename... Msg>
inline Error makeErrorLevel(Code&& code, Location location, Level level,
                            Msg&&... msg) noexcept {
    Error ccode{std::forward<Code>(code), location, std::forward<Msg>(msg)...};
    postProcess(ccode, location, level);
    return ccode;
}

template <typename Code, typename... Msg>
inline Error makeError(Code&& code, Location location, Msg&&... msg) noexcept {
    Error ccode{std::forward<Code>(code), location, std::forward<Msg>(msg)...};
    postProcess(ccode, location);
    return ccode;
}
}  // namespace ap::error
