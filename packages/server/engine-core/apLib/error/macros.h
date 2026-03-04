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

// Non throw error construction macros
#if ROCKETRIDE_PLAT_WIN
#define APERRT(Code, ...) \
    ::ap::error::makeErrorPrefix(Code, _location, *this, __VA_ARGS__)
#define APERRL(Level, Code, ...) \
    ::ap::error::makeErrorLevel(Code, _location, ::ap::Lvl::Level, __VA_ARGS__)
#define APERRLL(Level, Code, Location, ...) \
    ::ap::error::makeErrorLevel(Code, Location, ::ap::Lvl::Level, __VA_ARGS__)
#define APERRX(lvl, Code, ...) \
    ::ap::error::makeErrorLevel(Code, _location, lvl, __VA_ARGS__)
#define APERR(Code, ...) ::ap::error::makeError(Code, _location, __VA_ARGS__)

// Throw macros
#define APERRT_THROW(Code, ...) \
    throw ::ap::error::makeErrorPrefix(Code, _location, *this, __VA_ARGS__)
#define APERRL_THROW(Level, Code, ...) \
    throw ::ap::error::makeError(Code, _location, ::ap::Lvl::Level, __VA_ARGS__)
#define APERRLL_THROW(Level, Code, Location, ...) \
    throw ::ap::error::makeError(Code, Location, ::ap::Lvl::Level, __VA_ARGS__)
#define APERRX_THROW(lvl, Code, ...) \
    throw ::ap::error::makeError(Code, _location, lvl, __VA_ARGS__)
#define APERR_THROW(Code, ...) \
    throw ::ap::error::makeError(Code, _location, __VA_ARGS__)
#else
#define APERRT(Code, ...)                         \
    ::ap::error::makeErrorPrefix(Code, _location, \
                                 *this __VA_OPT__(, ) __VA_ARGS__)
#define APERRL(Level, Code, ...)                 \
    ::ap::error::makeErrorLevel(Code, _location, \
                                ::ap::Lvl::Level __VA_OPT__(, ) __VA_ARGS__)
#define APERRLL(Level, Code, Location, ...)     \
    ::ap::error::makeErrorLevel(Code, Location, \
                                ::ap::Lvl::Level __VA_OPT__(, ) __VA_ARGS__)
#define APERRX(lvl, Code, ...) \
    ::ap::error::makeErrorLevel(Code, _location, lvl __VA_OPT__(, ) __VA_ARGS__)
#define APERR(Code, ...) \
    ::ap::error::makeError(Code, _location __VA_OPT__(, ) __VA_ARGS__)

// Throw macros
#define APERRT_THROW(Code, ...)                         \
    throw ::ap::error::makeErrorPrefix(Code, _location, \
                                       *this __VA_OPT__(, ) __VA_ARGS__)
#define APERRL_THROW(Level, Code, ...)            \
    throw ::ap::error::makeError(Code, _location, \
                                 ::ap::Lvl::Level __VA_OPT__(, ) __VA_ARGS__)
#define APERRLL_THROW(Level, Code, Location, ...) \
    throw ::ap::error::makeError(Code, Location,  \
                                 ::ap::Lvl::Level __VA_OPT__(, ) __VA_ARGS__)
#define APERRX_THROW(lvl, Code, ...)              \
    throw ::ap::error::makeError(Code, _location, \
                                 lvl __VA_OPT__(, ) __VA_ARGS__)
#define APERR_THROW(Code, ...) \
    throw ::ap::error::makeError(Code, _location __VA_OPT__(, ) __VA_ARGS__)
#endif
