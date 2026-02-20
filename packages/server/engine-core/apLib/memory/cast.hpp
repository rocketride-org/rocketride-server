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

namespace ap::memory {

template <typename DataT = uint8_t, typename Arg>
_const auto viewCast(Arg& arg) noexcept {
    if constexpr (traits::IsPodV<Arg>)
        return DataView<DataT>{_reCast<DataT*>(&arg),
                               sizeof(Arg) / sizeof(DataT)};
    else if constexpr (traits::IsPairV<Arg>) {
        if constexpr (traits::IsPodPairV<Arg>)
            return DataView<DataT>{_reCast<DataT*>(&arg),
                                   sizeof(Arg) / sizeof(DataT)};
        else
            static_assert(sizeof(DataT) == 0,
                          "Unable to cast type to data view");
    } else if constexpr (traits::IsVectorV<Arg>) {
        if constexpr (traits::IsPairV<typename Arg::value_type>) {
            if constexpr (traits::IsPodPairV<typename Arg::value_type>)
                return DataView<DataT>{
                    _reCast<DataT*>(arg.data()),
                    (sizeof(typename Arg::value_type) * arg.size()) /
                        sizeof(DataT)};
            else
                static_assert(sizeof(DataT) == 0,
                              "Unable to cast vector of pairs to data view");
        } else if constexpr (traits::IsPodV<typename Arg::value_type>)
            return DataView<DataT>{
                _reCast<DataT*>(arg.data()),
                (sizeof(typename Arg::value_type) * arg.size()) /
                    sizeof(DataT)};
        else
            static_assert(sizeof(DataT) == 0,
                          "Unable to cast vector data view");
    } else if constexpr (traits::IsDataV<Arg>) {
        return DataView<DataT>{_reCast<DataT*>(arg.data()),
                               arg.byteSize() / sizeof(DataT)};
    } else if constexpr (traits::IsDataViewV<Arg>) {
        return DataView<DataT>{_reCast<DataT*>(arg.data()),
                               arg.byteSize() / sizeof(DataT)};
    } else if constexpr (std::is_convertible_v<Arg, DataView<DataT>>)
        return _cast<DataView<DataT>>(arg);
    else
        static_assert(sizeof(DataT) == 0, "Unable to cast type to data view");
}

template <typename DataT = uint8_t, typename Arg>
_const auto viewCast(const Arg& arg) noexcept {
    if constexpr (traits::IsPodV<Arg>)
        return DataView<const DataT>{_reCast<const DataT*>(&arg),
                                     sizeof(Arg) / sizeof(DataT)};
    else if constexpr (traits::IsPairV<Arg>) {
        if constexpr (traits::IsPodPairV<Arg>)
            return DataView<const DataT>{_reCast<const DataT*>(&arg),
                                         sizeof(Arg) / sizeof(DataT)};
        else
            static_assert(sizeof(DataT) == 0,
                          "Unable to cast type to data view");
    } else if constexpr (traits::IsVectorV<Arg>) {
        if constexpr (traits::IsPairV<typename Arg::value_type>) {
            if constexpr (traits::IsPodPairV<typename Arg::value_type>)
                return DataView<const DataT>{
                    _reCast<const DataT*>(arg.data()),
                    (sizeof(typename Arg::value_type) * arg.size()) /
                        sizeof(DataT)};
            else
                static_assert(sizeof(DataT) == 0,
                              "Unable to cast vector of pairs to data view");
        } else if constexpr (traits::IsPodV<typename Arg::value_type>)
            return DataView<const DataT>{
                _reCast<const DataT*>(arg.data()),
                (sizeof(typename Arg::value_type) * arg.size()) /
                    sizeof(DataT)};
        else
            static_assert(sizeof(DataT) == 0,
                          "Unable to cast vector data view");
    } else if constexpr (traits::IsDataV<Arg>) {
        return DataView<const DataT>{_reCast<const DataT*>(arg.data()),
                                     arg.byteSize() / sizeof(DataT)};
    } else if constexpr (traits::IsDataViewV<Arg>) {
        return DataView<const DataT>{_reCast<const DataT*>(arg.data()),
                                     arg.byteSize() / sizeof(DataT)};
    } else if constexpr (std::is_convertible_v<Arg, DataView<const DataT>>)
        return _cast<DataView<const DataT>>(arg);
    else
        static_assert(sizeof(DataT) == 0, "Unable to cast type to data view");
}

}  // namespace ap::memory
