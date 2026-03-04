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

namespace ap::error {
template <typename T>
using DetectDeref =
    std::negation<std::is_void<decltype(std::declval<T &>().operator->())>>;

template <typename ResultT>
struct ResultTraits {
    _const auto IsVoid = std::is_void_v<ResultT>;
    _const auto IsSmartPtr = traits::IsSmartPtrV<ResultT>;
    _const auto IsValue =
        !std::is_void_v<ResultT> && !traits::IsSmartPtrV<ResultT>;
    _const auto IsIntegral = std::is_integral_v<ResultT>;
    _const auto IsCopyable = std::is_copy_constructible_v<ResultT> ||
                             std::is_copy_assignable_v<ResultT>;
    _const auto IsBool = traits::IsSameTypeV<ResultT, bool>;
    _const auto IsNumeric = std::is_arithmetic_v<ResultT>;
    _const auto IsBoolOrCopyable = IsBool || IsCopyable;
    _const auto HasDeref = traits::IsDetected<DetectDeref, ResultT>{};
};

}  // namespace ap::error
