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

namespace ap::traits {

APTRAIT_DEF(DataView, memory::DataView);
APTRAIT_DEF(Data, memory::Data);

// IsContiguousContainer
template <typename T>
struct IsContiguousContainer {
    static constexpr bool value =
        IsVectorV<T> || IsArrayV<T> || IsStrV<T> || IsStrViewV<T> ||
        IsStdStringV<T> || IsStdStringViewV<T> || IsDataViewV<T> || IsDataV<T>;
};

template <typename T>
constexpr bool IsContiguousContainerV = IsContiguousContainer<T>::value;

template <typename T>
using IfContiguousContainer =
    std::enable_if_t<traits::IsContiguousContainerV<T>>;

// IsContiguousPodContainer
template <typename T>
constexpr bool IsContiguousPodContainer() {
    if constexpr (IsContiguousContainerV<T>) {
        if constexpr (IsPodV<typename T::value_type>)
            return true;
        else if constexpr (IsPairV<typename T::value_type>) {
            if constexpr (IsPodPairV<typename T::value_type>)
                return true;
            else
                return false;
        } else
            return false;
    } else
        return false;
}

template <typename T>
using IfContiguousPodContainer =
    std::enable_if_t<IsContiguousPodContainer<T>()>;

template <typename T, typename Y>
using IfSameType = std::enable_if_t<IsSameTypeV<T, Y>>;

}  // namespace ap::traits
