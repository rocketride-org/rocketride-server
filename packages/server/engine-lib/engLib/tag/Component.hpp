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

namespace engine::tag {

// Define the binary headers used to encode a component
struct Component {
    // Start of the component
    using CompBegin = Hdr<Class::Component, Type::Begin>;

    // Start of the segment
    using SegBegin = HdrData<Hdr<Class::Segment, Type::Begin>,
                             compress::Type  // compression type of the segment
                             >;

    // Uncompressed segment data
    using SegData = HdrData<Hdr<Class::Segment, Type::Data>,
                            uint32_t  // size of the proceeding data
                            >;

    // Compressed segment data
    using SegDeflatedData =
        HdrData<Hdr<Class::Segment, Type::DeflatedData>,
                uint32_t,  // size of the following data, if the size of this
                           // data equals the deflated size then the block grew
                           // when we tried to compress it, and we just used the
                           // uncompressed block instead
                uint32_t   // deflated size
                >;

    // Marker for end of the component itself
    using CompEnd =
        HdrData<Hdr<Class::Component, Type::Signature>, crypto::Sha512Hash>;
};

}  // namespace engine::tag
