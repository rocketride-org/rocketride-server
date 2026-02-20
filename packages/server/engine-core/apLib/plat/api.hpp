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

namespace ap::plat {

inline Text env(const Text& key) noexcept {
#if ROCKETRIDE_PLAT_WIN
    // Support environment variables up to 1k in length
    // If we use getenv instead here, we may not see environment variables set
    // via SetEnvironmentVariableA
    char buffer[1024];
    if (auto res = ::GetEnvironmentVariableA(key, buffer, sizeof(buffer));
        res && res < sizeof(buffer))
        return Text{buffer, res};
#else
#if ROCKETRIDE_PLAT_LIN
    auto val = ::secure_getenv(key);
#else
    auto val = ::getenv(key);
#endif

    if (val) return Text{val};
#endif
    return {};
}

inline Text envOr(const Text& key, TextView defaultValue) noexcept {
    auto value = env(key);
    if (value) return value;
    return defaultValue;
}

inline void setEnv(const Text& key, const Text& value) noexcept {
#if ROCKETRIDE_PLAT_WIN
    ::SetEnvironmentVariableA(key, value);
#else
    ::setenv(key, value, 1);
#endif
}

// Parse account name from NetBIOS username (e.g. "domain\user")
inline Text accountFromUsername(TextView username) noexcept {
    if (auto comps = string::view::splitAtToken(username, '\\'); comps.right)
        return comps.right;
    return username;
}

// Parse domain name from NetBIOS username (e.g. "domain\user")
inline Text domainFromUsername(TextView username) noexcept {
    if (auto comps = string::view::splitAtToken(username, '\\'); comps.right)
        return comps.left;
    return {};
}

}  // namespace ap::plat
