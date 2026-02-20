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

// This structure is used to pass information about where
// an exception was thrown, or where something was called, including
// its line/file/function.
struct Location {
    // Boolean operator returns true of this location has a path
    // set in it
    constexpr operator bool() const noexcept { return m_path.empty() == false; }

    const Location &operator||(const Location &other) const noexcept;
    bool operator<(const Location &other) const noexcept;

    bool operator==(const Location &other) const noexcept {
        return m_path == other.m_path && m_line == other.m_line &&
               m_function == other.m_function;
    }

    bool operator!=(const Location &other) const noexcept {
        return !operator==(other);
    }

    template <typename Buffer>
    void toString(Buffer &buff, bool includeFunction = false,
                  bool includeFile = true) const noexcept;
    std::string fileName() const noexcept;
    std::string function() const noexcept;
    int line() const noexcept;
    static std::string sanitizeFunctionName(std::string_view name) noexcept;

    // We use string_view's here so that *no* allocations occur
    // this requires that all strings passed here must be constant
    // literals
    std::string_view m_path;
    int m_line = 0;
    std::string_view m_function;
    bool m_fullPath = false;
};

}  // namespace ap

// Posix compilers have a nice pretty function macro, use that
// rather then the c standard function, on windows the built in
// one is fine
#if defined(__PRETTY_FUNCTION__)
#define CURRENT_FUNCTION __PRETTY_FUNCTION__
#else
#define CURRENT_FUNCTION __FUNCTION__
#endif

// Use this macro to instantiate a location
#define _location (::ap::Location{__FILE__, __LINE__, CURRENT_FUNCTION})

// LocationOr allows for default argument usage, say you have a function
// that you optionally want the caller to pass in their location but
// you don't want to require it
//	e.g.
//		void myFunction(Location location = {}) {
//			Error{Ec::WOOPS, locationOr(location), "Oppsie"}
//
// This will use the callers location, or the location where locationOr
// was used
#define _locationOr(other) ((_location.operator||(other)))
