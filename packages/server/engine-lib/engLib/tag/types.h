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

namespace engine::tag {
// Master tagging version list
enum class Version : uint64_t {
    // V1 tags
    V1 = makeId("APTAGV1")
};

// Classes are the top level feature or object that is creating and consuming
// the tag headers
enum class Class : uint64_t {
    // Generic reads any type and allows us to discover
    // headers
    Generic,

    // Major classes denoting the data encapsulated
    // Note these are all committed to disk so don't modify
    Words = makeId("CmpWds"),
    Component = makeId("Cmp"),
    Segment = makeId("Seg"),
};

inline decltype(auto) operator<<(std::ostream& stream,
                                 const Class& arg) noexcept {
    return stream << idName(arg);
}

// Type describe the kind of data in the tag
enum class Type : uint64_t {
    // Special types, none indicates no type specified,
    // which implies no data will follow
    None,

    // Generic reads any type and allows us to discover
    // headers
    Generic,

    // Generic types for use in other classes
    Index = makeId("Index"),

    // Standard unencrypted, uncompressed data
    Data = makeId("Data"),

    // Compressed data
    DeflatedData = makeId("DefData"),

    // Data end marker (may apply to either compdata or normal data)
    DataEnd = makeId("DataEnd"),

    // Signature of a component
    Signature = makeId("Sig"),

    // Generic begin marker
    Begin = makeId("Beg"),

    // Generic end marker
    End = makeId("End"),
};

inline decltype(auto) operator<<(std::ostream& stream,
                                 const Type& arg) noexcept {
    return stream << idName(arg);
}

}  // namespace engine::tag
