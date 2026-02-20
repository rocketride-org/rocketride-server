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

namespace ap::json {

// From json
template <typename ArgType, typename... Args>
using DetectFromJsonMethod = decltype(std::declval<ArgType &>().__fromJson(
    std::declval<ArgType &>(), std::declval<const json::Value &>(),
    std::declval<Args>()...));

template <typename ArgType, typename... Args>
using DetectThrowingFromJsonMethod =
    decltype(std::declval<ArgType &>().__fromJson(
        std::declval<const json::Value &>(), std::declval<Args>()...));

template <typename ArgType, typename... Args>
using DetectFromJsonFunction = decltype(__fromJson(
    std::declval<ArgType &>(), std::declval<const json::Value &>(),
    std::declval<Args>()...));

// To json
template <typename ArgType>
using DetectToJsonMethod = decltype(std::declval<const ArgType &>().__toJson(
    std::declval<json::Value &>()));

template <typename ArgType>
using DetectToJsonFunction = decltype(__toJson(std::declval<const ArgType &>(),
                                               std::declval<json::Value &>()));

// HasSchema
template <typename, typename = void>
struct HasSchema : std::false_type {};

template <typename T>
struct HasSchema<
    T,
    std::conditional_t<
        false, std::void_t<decltype(std::declval<T>().__jsonSchema())>, void>>
    : std::true_type {};

template <typename T>
_const auto HasSchemaV = HasSchema<T>::value;

template <typename T>
using DetectJsonValidateMethod = decltype(std::declval<T &>().__jsonValidate());

template <typename T>
_const auto HasJsonValidateV =
    traits::IsDetectedExact<Error, DetectJsonValidateMethod, T>{};

template <typename T>
using DetectValidMethod = decltype(std::declval<T &>().valid());

template <typename T>
_const auto HasValidV = traits::IsDetectedExact<bool, DetectValidMethod, T>{};

}  // namespace ap::json
