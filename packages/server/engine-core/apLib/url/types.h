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

// <protocol>://<Prefix>/<authority>/<path>?<parameter1>&<parameter2>...
struct Protocol : public Text {
    using Text::Text;
};
struct ProtocolWithoutAuthority : public Text {
    using Text::Text;
};
struct Authority : public Text {
    using Text::Text;
};
struct Component : public Text {
    using Text::Text;
};
struct End {};

template <typename T>
struct ParameterValue {
    Text key;
    T val;
};

// Constexpr static definition for a parameter, constexpr as a result
// of its default being TextView
template <typename T = TextView>
struct ParameterDefinition {
    using Type = T;

    constexpr explicit ParameterDefinition(TextView _key, T _def = {}) noexcept
        : key(_key), def(_def) {}

    TextView key;
    T def;
};

}  // namespace ap::url
