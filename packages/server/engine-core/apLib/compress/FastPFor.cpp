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

// Fast numeric compression
#pragma warning(disable : 4267)
#include <apLib/ap.h>
#undef ASSERT

#include <FastPFor/common.h>
#include <FastPFor/codecs.h>
#include <FastPFor/compositecodec.h>
#include <FastPFor/variablebyte.h>
#include <FastPFor/vsencoding.h>
#include <FastPFor/util.h>
#include <FastPFor/fastpfor.h>
#include <FastPFor/simdfastpfor.h>

namespace FastPFor {

using FastPFor256 = FastPForLib::CompositeCodec<FastPForLib::FastPFor<8>,
                                                FastPForLib::VariableByte>;
using CodecT = FastPFor256;

void encode(const uint32_t *data, size_t len, uint32_t *out,
            size_t &compressedSize) noexcept {
    _thread_local async::Tls<CodecT> codec{_location};
    codec->encodeArray(data, len, out, compressedSize);
}

void decode(const uint32_t *data, size_t len, uint32_t *out,
            size_t &recoveredSize) noexcept {
    _thread_local async::Tls<CodecT> codec{_location};
    codec->decodeArray(data, len, out, recoveredSize);
}

// Faspfor uses avx2
bool doesCpuSupportAvx2() noexcept {
    auto info = plat::CpuInfo();
    return info.AVX2();
}

}  // namespace FastPFor
