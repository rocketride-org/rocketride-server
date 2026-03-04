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

//
//	Log macro definitions
//
#pragma once

// Log assuming this is present, allows for a custom location, prefix of this
// class type will get prefixed, custom additional level to check
#define LOGTTL(LEVEL, location, ...)                                     \
    do {                                                                 \
        if (::ap::log::isLevelEnabled<false>(::ap::Lvl::LEVEL,           \
                                             this->LogLevel)) {          \
            ::ap::log::writePrefix(                                      \
                ::ap::FormatOptions{                                     \
                    ::ap::Format::DECORATE | ::ap::Format::RTTIOK |      \
                        ::ap::Format::JSONOK | ::ap::Format::ERROROROK | \
                        ::ap::Format::LOGGING,                           \
                    ::ap::Format::DefWidth, ' '},                        \
                location, *this, __VA_ARGS__);                           \
        }                                                                \
                                                                         \
    } while (false)

// Log assuming this is present, allows for a custom location, prefix of this
// class type will get prefixed
#define LOGTL(location, ...)                                             \
    do {                                                                 \
        if (::ap::log::isLevelEnabled(this->LogLevel)) {                 \
            ::ap::log::writePrefix(                                      \
                ::ap::FormatOptions{                                     \
                    ::ap::Format::DECORATE | ::ap::Format::RTTIOK |      \
                        ::ap::Format::JSONOK | ::ap::Format::ERROROROK | \
                        ::ap::Format::LOGGING,                           \
                    ::ap::Format::DefWidth, ' '},                        \
                location, *this, __VA_ARGS__);                           \
        }                                                                \
                                                                         \
    } while (false)

// Log assuming this is present, allows for a custom location, prefix of this
// class type will get prefixed, custom level to check as an override
#define LOGTTOL(LEVEL, location, ...)                                    \
    do {                                                                 \
        if (::ap::log::isLevelEnabled<false>(::ap::Lvl::LEVEL)) {        \
            ::ap::log::writePrefix(                                      \
                ::ap::FormatOptions{                                     \
                    ::ap::Format::DECORATE | ::ap::Format::RTTIOK |      \
                        ::ap::Format::JSONOK | ::ap::Format::ERROROROK | \
                        ::ap::Format::LOGGING,                           \
                    ::ap::Format::DefWidth, ' '},                        \
                location, *this, __VA_ARGS__);                           \
        }                                                                \
                                                                         \
    } while (false)

// Log assuming this is present, prefix of this class type will get prefixed
#define LOGT(...) LOGTL(_location, __VA_ARGS__)

// Log with this level and another optional one
#define LOGTT(LEVEL, ...) LOGTTL(LEVEL, _location, __VA_ARGS__)

// Log with this and override the log level to check
#define LOGTO(LEVEL, ...) LOGTTOL(LEVEL, _location, __VA_ARGS__)

// Log no this with custom level and location, no prefix
#define LOGL(LEVEL, location, ...)                                             \
    do {                                                                       \
        if (::ap::log::isLevelEnabled(LEVEL)) {                                \
            ::ap::log::write(::ap::FormatOptions{::ap::Format::DECORATE |      \
                                                     ::ap::Format::RTTIOK |    \
                                                     ::ap::Format::JSONOK |    \
                                                     ::ap::Format::ERROROROK | \
                                                     ::ap::Format::LOGGING,    \
                                                 ::ap::Format::DefWidth, ' '}, \
                             location, __VA_ARGS__);                           \
        }                                                                      \
                                                                               \
    } while (false)

// Log no this and custom level (without Lvl::), no prefix
#define LOG(LEVEL, ...) LOGL(::ap::Lvl::LEVEL, _location, __VA_ARGS__)

// Log no this and custom level (with Lvl::), no prefix
#define LOGX(lvl, ...) LOGL(lvl, _location, __VA_ARGS__)

#define LOGOUTPUT(...)                                                    \
    ::ap::log::write(                                                     \
        ::ap::FormatOptions{::ap::Format::RTTIOK | ::ap::Format::JSONOK | \
                                ::ap::Format::ERROROROK |                 \
                                ::ap::Format::LOGGING,                    \
                            ::ap::Format::DefWidth, ' '},                 \
        _location, __VA_ARGS__)