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

namespace ap::url {

// Define a parameter definition with default, used in static
// or constexpr scopes for global definitions in url schemas
template <typename T = TextView>
constexpr auto defineParameter(TextView key, T def = {}) noexcept {
    return ParameterDefinition<T>(key, _mv(def));
}

// Builder helpers

// Make an parameter value, if value not set will nullop on a
// build stream
template <typename T = Text>
inline decltype(auto) parameter(Text key, T val) noexcept {
    if constexpr (traits::IsOptionalV<T>) {
        if (!val) return ParameterValue<T>{};
        return ParameterValue<T>{.key = _mv(key), .val = _mvOpt(val)};
    } else {
        return ParameterValue<Text>{.key = _mv(key), .val = _ts(val)};
    }
}

// Make an parameter value with a definition
template <typename T, typename V>
inline decltype(auto) parameter(const ParameterDefinition<T>& def,
                                const V& val) noexcept {
    if constexpr (traits::IsOptionalV<V>)
        return ParameterValue<Text>{.key = def.key,
                                    .val = _ts(val.value_or(def.def))};
    else
        return ParameterValue<Text>{.key = def.key, .val = _ts(val)};
}

inline decltype(auto) authority(Text auth) noexcept {
    return Authority{_mv(auth)};
}

inline decltype(auto) authority(TextView ip, uint16_t port) noexcept {
    return authority(_ts(ip, ":", port));
}

inline decltype(auto) protocol(Text name) noexcept {
    return Protocol{_mv(name)};
}

inline decltype(auto) component(Text component) noexcept {
    return Component{_mv(component)};
}

inline decltype(auto) protocolWithoutAuthority(Text name) noexcept {
    return ProtocolWithoutAuthority{_mv(name)};
}

template <typename T = file::Path>
inline decltype(auto) path(T&& p) noexcept {
    if constexpr (traits::IsOptionalV<T>)
        return file::Path{p.value_or("")};
    else
        return file::Path{std::forward<T>(p)};
}

inline decltype(auto) builder() noexcept { return Builder(); }

inline decltype(auto) end() noexcept { return End(); }

}  // namespace ap::url