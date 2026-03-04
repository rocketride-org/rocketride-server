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

namespace ap::string::internal {

struct PackTag {
    struct UserMayFailMethod {};
    struct UserNoFailMethod {};
    struct UserMayFailMethodOpts {};
    struct UserNoFailMethodOpts {};

    struct UserMayFailFunction {};
    struct UserNoFailFunction {};
    struct UserMayFailFunctionOpts {};
    struct UserNoFailFunctionOpts {};

    struct Container {};
    struct Number {};
    struct String {};
    struct Misc {};
};

// Detectors for detecting methods on types

// aws to_string api
template <typename ArgType>
using DetectToStringMethod = decltype(std::declval<ArgType &>().to_string());

// __toString user api hooks
template <typename ArgType, typename BufferType>
using DetectPackMethod = decltype(std::declval<ArgType &>().__toString(
    std::declval<BufferType &>()));

template <typename ArgType, typename BufferType>
using DetectPackMethodOpts = decltype(std::declval<ArgType &>().__toString(
    std::declval<BufferType &>(), std::declval<const FormatOptions &>()));

// __fromString user api hooks
template <typename ArgType, typename BufferType>
using DetectUnpackMethod = decltype(std::declval<ArgType &>().__fromString(
    std::declval<ArgType &>(), std::declval<const BufferType &>()));

template <typename ArgType, typename BufferType>
using DetectUnpackMethodOpts = decltype(std::declval<ArgType &>().__fromString(
    std::declval<ArgType &>(), std::declval<const BufferType &>(),
    std::declval<const FormatOptions &>()));

// Constexpr functions that detect __toString pack hooks
template <typename Result, typename ArgType, typename BufferType>
_const bool detectPackMethod() noexcept {
    return traits::IsDetectedExact<Result, DetectPackMethod, ArgType,
                                   BufferType>{};
}

template <typename Result, typename ArgType, typename BufferType>
_const bool detectPackMethodOpts() noexcept {
    return traits::IsDetectedExact<Result, DetectPackMethodOpts, ArgType,
                                   BufferType>{};
}

// Constexpr functions that detect __fromString pack hooks
template <typename Result, typename ArgType, typename BufferType>
_const bool detectUnpackMethod() noexcept {
    return traits::IsDetectedExact<Result, DetectUnpackMethod, ArgType,
                                   BufferType>{};
}

template <typename Result, typename ArgType, typename BufferType>
_const bool detectUnpackMethodOpts() noexcept {
    return traits::IsDetectedExact<Result, DetectUnpackMethodOpts, ArgType,
                                   BufferType>{};
}

//
// Detectors for detecting functions with ADL
//

template <typename ArgType, typename BufferType>
using DetectPackFunction = decltype(__toString(std::declval<const ArgType &>(),
                                               std::declval<BufferType &>()));

template <typename ArgType, typename BufferType>
using DetectPackFunctionOpts = decltype(__toString(
    std::declval<const ArgType &>(), std::declval<BufferType &>(),
    std::declval<const FormatOptions &>()));

template <typename ArgType, typename BufferType>
using DetectUnpackFunction = decltype(__fromString(
    std::declval<ArgType &>(), std::declval<const BufferType &>()));

template <typename ArgType, typename BufferType>
using DetectUnpackFunctionOpts = decltype(__fromString(
    std::declval<ArgType &>(), std::declval<const BufferType &>(),
    std::declval<const FormatOptions &>()));

template <typename Result, typename ArgType, typename BufferType>
_const bool detectPackFunction() noexcept {
    return traits::IsDetectedExact<Result, DetectPackFunction, ArgType,
                                   BufferType>{};
}

template <typename Result, typename ArgType, typename BufferType>
_const bool detectPackFunctionOpts() noexcept {
    return traits::IsDetectedExact<Result, DetectPackFunctionOpts, ArgType,
                                   BufferType>{};
}

// Constexpr functions that detect __fromString pack hooks
template <typename Result, typename ArgType, typename BufferType>
_const bool detectUnpackFunction() noexcept {
    return traits::IsDetectedExact<Result, DetectUnpackFunction, ArgType,
                                   BufferType>{};
}

template <typename Result, typename ArgType, typename BufferType>
_const bool detectUnpackFunctionOpts() noexcept {
    return traits::IsDetectedExact<Result, DetectUnpackFunctionOpts, ArgType,
                                   BufferType>{};
}

// Front end apis that return the tag from the detection for string based
// pack/unpack
template <typename ArgType, typename BufferType>
constexpr auto detectPackTag() noexcept {
    static_assert(traits::IsPackAdapterV<BufferType>, "Invalid argument");

    // Method
    if constexpr (detectPackMethod<Error, ArgType, BufferType>())
        return PackTag::UserMayFailMethod{};
    else if constexpr (detectPackMethod<void, ArgType, BufferType>())
        return PackTag::UserNoFailMethod{};
    else if constexpr (detectPackMethodOpts<Error, ArgType, BufferType>())
        return PackTag::UserMayFailMethodOpts{};
    else if constexpr (detectPackMethodOpts<void, ArgType, BufferType>())
        return PackTag::UserNoFailMethodOpts{};

    // Functions (adl lookup)
    else if constexpr (detectPackFunction<Error, ArgType, BufferType>())
        return PackTag::UserMayFailFunction{};
    else if constexpr (detectPackFunction<void, ArgType, BufferType>())
        return PackTag::UserNoFailFunction{};
    else if constexpr (detectPackFunctionOpts<Error, ArgType, BufferType>())
        return PackTag::UserMayFailFunctionOpts{};
    else if constexpr (detectPackFunctionOpts<void, ArgType, BufferType>())
        return PackTag::UserNoFailFunctionOpts{};

    else if constexpr (PackTraits<ArgType>::IsClassString)
        return PackTag::String{};
    else if constexpr (PackTraits<ArgType>::IsClassNumber)
        return PackTag::Number{};
    else if constexpr (PackTraits<ArgType>::IsClassContainer)
        return PackTag::Container{};
    else
        return PackTag::Misc{};
}

template <typename ArgType, typename BufferType>
constexpr auto detectUnpackTag() noexcept {
    static_assert(traits::IsPackAdapterV<BufferType>, "Invalid argument");

    // Methods
    if constexpr (detectUnpackMethod<Error, ArgType, BufferType>())
        return PackTag::UserMayFailMethod{};
    else if constexpr (detectUnpackMethod<void, ArgType, BufferType>())
        return PackTag::UserNoFailMethod{};
    else if constexpr (detectUnpackMethodOpts<Error, ArgType, BufferType>())
        return PackTag::UserMayFailMethodOpts{};
    else if constexpr (detectUnpackMethodOpts<void, ArgType, BufferType>())
        return PackTag::UserNoFailMethodOpts{};

    // Functions (adl lookup)
    else if constexpr (detectUnpackFunction<Error, ArgType, BufferType>())
        return PackTag::UserMayFailFunction{};
    else if constexpr (detectUnpackFunction<void, ArgType, BufferType>())
        return PackTag::UserNoFailFunction{};
    else if constexpr (detectUnpackFunctionOpts<Error, ArgType, BufferType>())
        return PackTag::UserMayFailFunctionOpts{};
    else if constexpr (detectUnpackFunctionOpts<void, ArgType, BufferType>())
        return PackTag::UserNoFailFunctionOpts{};
    else if constexpr (PackTraits<ArgType>::IsClassString)
        return PackTag::String{};
    else if constexpr (PackTraits<ArgType>::IsClassNumber)
        return PackTag::Number{};
    else if constexpr (PackTraits<ArgType>::IsClassContainer)
        return PackTag::Container{};
    else
        return PackTag::Misc{};
}

}  // namespace ap::string::internal
