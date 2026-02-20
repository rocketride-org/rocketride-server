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

namespace ap::memory::adapter::concepts {

template <typename TestType>
using DetectOffsetMethod = decltype(std::declval<const TestType &>().offset());

template <typename TestType>
using DetectSizeMethod = decltype(std::declval<const TestType &>().size());

template <typename TestType>
using DetectPathMethod = decltype(std::declval<const TestType &>().path());

template <typename TestType>
using DetectSetOffsetMethod =
    decltype(std::declval<const TestType &>().setOffset(
        std::declval<uint64_t>()));

template <typename TestType>
using DetectWriteMethod =
    decltype(std::declval<TestType &>().write(std::declval<InputData>()));

template <typename TestType>
using DetectReadMethod = decltype(std::declval<const TestType &>().read(
    std::declval<OutputData>(), std::declval<size_t>()));

template <typename TestType>
using DetectConstMakeMethod = decltype(std::declval<const TestType &>().make(
    std::declval<const file::Path &>()));

template <typename TestType>
using DetectMakeMethod = decltype(std::declval<TestType &>().make(
    std::declval<const file::Path &>()));

template <typename T>
_const auto IsInputV =
    traits::IsDetectedExact<uint64_t, DetectOffsetMethod, T>{} &&
    traits::IsDetectedExact<uint64_t, DetectSizeMethod, T>{} &&
    traits::IsDetectedExact<void, DetectSetOffsetMethod, T>{} &&
    traits::IsDetectedExact<size_t, DetectReadMethod, T>{} &&
    traits::IsDetectedExact<file::Path, DetectPathMethod, T>{};

template <typename T, typename Y = void>
using IfInput = std::enable_if_t<IsInputV<T>, Y>;

template <typename T, typename Y = void>
using IfNotInput = std::enable_if_t<!IsInputV<T>, Y>;

template <typename T>
_const auto IsOutputV =
    traits::IsDetectedExact<uint64_t, DetectOffsetMethod, T>{} &&
    traits::IsDetectedExact<uint64_t, DetectSizeMethod, T>{} &&
    traits::IsDetectedExact<void, DetectSetOffsetMethod, T>{} &&
    traits::IsDetectedExact<void, DetectWriteMethod, T>{} &&
    traits::IsDetectedExact<file::Path, DetectPathMethod, T>{};

template <typename T, typename Y = void>
using IfOutput = std::enable_if_t<IsOutputV<T>, Y>;

template <typename T, typename Y = void>
using IfNotOutput = std::enable_if_t<!IsOutputV<T>, Y>;

}  // namespace ap::memory::adapter::concepts
