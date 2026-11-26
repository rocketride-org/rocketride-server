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

namespace ap::memory {

// DataView deductions for strings and arrays
template <typename ChrT, typename TraitsT, typename AllocT>
DataView(const string::Str<ChrT, TraitsT, AllocT> &) -> DataView<const ChrT>;

template <typename ChrT, typename TraitsT>
DataView(string::StrView<ChrT, TraitsT>) -> DataView<const ChrT>;

template <typename DataT, size_t Len>
DataView(const Array<DataT, Len> &) -> DataView<const DataT>;

// Dataview deductions for Data
template <typename DataT, typename AllocT>
DataView(const Data<DataT, AllocT> &) -> DataView<const DataT>;

template <typename DataT, typename AllocT>
DataView(Data<DataT, AllocT> &) -> DataView<DataT>;

// Data deductions for DataView strings and arrays
template <typename DataT>
Data(DataView<DataT>) -> Data<DataT>;

template <typename ChrT, typename TraitsT, typename AllocT>
Data(const string::Str<ChrT, TraitsT, AllocT> &) -> Data<const ChrT, AllocT>;

template <typename ChrT, typename TraitsT>
Data(string::StrView<ChrT, TraitsT>) -> Data<const ChrT>;

template <typename DataT, size_t Len>
Data(Array<DataT, Len> &) -> Data<DataT>;

template <typename DataT, size_t Len>
Data(const Array<DataT, Len> &) -> Data<const DataT>;

}  // namespace ap::memory
