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

template <typename DataT, typename AllocT, typename In>
inline void __fromData(Data<DataT, AllocT> &data,
                       const In &in) noexcept(false) {
    // Grow to accommodate what is being read
    auto byteSize = fromData<PackHdr>(in)->size;
    data.resize(byteSize / sizeof(DataT));
    in.read({_reCast<uint8_t *>(data.data()), byteSize});
}

template <typename DataT, typename Out>
inline void __toData(const DataView<DataT> &data, Out &out) noexcept(false) {
    // Since we are a dynamic sized thing write out a pack header
    // so we know how big we need to resize
    auto byteSize = data.byteSize();
    out.write(viewCast(PackHdr(byteSize)));
    out.write({_reCast<const uint8_t *>(data.data()), byteSize});
}

template <typename DataT, typename AllocT, typename Out>
inline void __toData(const Data<DataT, AllocT> &data,
                     Out &out) noexcept(false) {
    // Since we are a dynamic sized thing write out a pack header
    // so we know how big we need to resize
    auto byteSize = data.byteSize();
    out.write(viewCast(PackHdr(byteSize)));
    out.write({_reCast<const uint8_t *>(data.data()), byteSize});
}

}  // namespace ap::memory
