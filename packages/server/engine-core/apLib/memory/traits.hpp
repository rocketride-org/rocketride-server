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

namespace ap::memory::traits {

// Bridge ap traits here
using namespace ::ap::traits;

// __toData user api hooks
template <typename ArgType, typename BufferType>
using DetectDataPackMethod =
    decltype(std::declval<ArgType &>().__toData(std::declval<BufferType &>()));

template <typename ArgType, typename BufferType>
using DetectDataPackFunction = decltype(__toData(
    std::declval<const ArgType &>(), std::declval<BufferType &>()));

// __fromData user api hooks
template <typename ArgType, typename BufferType, typename... Args>
using DetectDataUnpackMethod = decltype(std::declval<ArgType &>().__fromData(
    std::declval<ArgType &>(), std::declval<const BufferType &>(),
    std::declval<Args>()...));

template <typename ArgType, typename BufferType, typename... Args>
using DetectDataUnpackFunction = decltype(__fromData(
    std::declval<ArgType &>(), std::declval<const BufferType &>(),
    std::declval<Args>()...));

// Detects a magic method __validate, this is called after a read is
// performed on a type, this gives the type a way to self validate
// and throw if there's a problem
template <typename ArgType>
using DetectValidateMethod = decltype(std::declval<ArgType &>().__validate());

// Self validating method for post fromData hook
template <typename T>
_const auto HasValidateV =
    traits::IsDetectedExact<Error, traits::DetectValidateMethod, T>{} ||
    traits::IsDetectedExact<void, traits::DetectValidateMethod, T>{};

}  // namespace ap::memory::traits
