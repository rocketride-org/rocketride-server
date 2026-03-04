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

// Assertion macro, logs the line, breaks into the debugger, then aborts.
// ASSERTD, ASSERTD_MSG	<-- Always checks, debug/release
// ASSERT, ASSERT_MSG	<-- Only checks on debug, null op on release
#define ASSERTD_MSG(x, ...)                                               \
    do {                                                                  \
        if (!(x)) {                                                       \
            ::ap::dev::enterDebugger(_location, "Assertion Failure:", #x, \
                                     __VA_ARGS__);                        \
            std::abort();                                                 \
        }                                                                 \
    } while (false)

#define ASSERTD(x)                                                         \
    do {                                                                   \
        if (!(x)) {                                                        \
            ::ap::dev::enterDebugger(_location, "Assertion Failure:", #x); \
            std::abort();                                                  \
        }                                                                  \
    } while (false)

#if defined(ROCKETRIDE_BUILD_DEBUG)
#define ASSERT_MSG(x, ...) ASSERTD_MSG(x, __VA_ARGS__)
#define ASSERT(x) ASSERTD(x)
#else
#define ASSERT_MSG(x, ...) \
    do {                   \
    } while (false)
#define ASSERT(x) \
    do {          \
    } while (false)
#endif

#define _fatality(...) ::ap::dev::fatality(_location, __VA_ARGS__)