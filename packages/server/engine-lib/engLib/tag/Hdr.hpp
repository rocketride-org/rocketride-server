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

// Align on a byte boundary for compactness
#pragma pack(push, 1)

// The tag Hdr is a generic construct that represents a logical group
// in a binary stream
template <Class ClassIdT, Type TypeIdT = Type::None>
struct Hdr final {
    // Allow this header to be treated as a Pod type
    using PodType = std::true_type;

    // Forward the template args as concrete values
    _const auto ClassId = ClassIdT;
    _const auto TypeId = TypeIdT;

    // Conditionally enable methods based on the type of this header
    template <typename T>
    using IfGeneirc = std::enable_if_t<T::ClassId == Class::Generic>;

    // Main signature
    Version signature = Version::V1;

    // Class id denotes an id reserved for a logical classId of
    // headers related to a single feature or api
    Class classId = ClassId;

    // Tag id describes what this tag represents, relative to
    // the classId
    Type typeId = TypeId;

    // Validate the current values of the header, this is called in the
    // read apis to validate the expected header
    auto __validate() const noexcept(false) {
        // Invalid sigs are always checked
        if (signature != Version::V1)
            APERR_THROW(Ec::TagInvalidSig, signature, "!=", Version::V1);

        // Generic classes don't validate the class or the type ids
        // this allows opaque reading of any tag
        if (ClassId != Class::Generic && classId != ClassId)
            APERR_THROW(Ec::TagInvalidClass, classId, "!=", ClassId);
        if (TypeId != Type::Generic && typeId != TypeId)
            APERR_THROW(Ec::TagInvalidType, typeId, "!=", TypeId);
    }

    // Header cast attempts to cast headers from generic types
    // only enabled when the type of this header is a generic type
    template <typename HdrT, typename T = Hdr, typename = IfGeneirc<T>>
    bool cast() const noexcept {
        return classId == HdrT::ClassId && typeId == HdrT::TypeId;
    }

    // Allow casting to data views for binary i/o
    operator InputData() const noexcept {
        return {_reCast<const uint8_t *>(this), sizeof(*this)};
    }

    operator OutputData() noexcept {
        return {_reCast<uint8_t *>(this), sizeof(*this)};
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        return _tsb(buff, "TagHdr[", classId, "|", typeId, "]");
    }

    static auto name() noexcept {
        return _ts("TagHdr[", ClassId, "|", TypeId, "]");
    }
};

// Alias a concrete type meant for generic reading of headers
using GenericHdr = Hdr<Class::Generic, Type::Generic>;

// HdrData is a composed type that allows definitions to
// pair a header and a series of types
template <typename HdrT, typename... Args>
struct HdrData {
    // Do not allow this to be treated as a pod type, this
    // will statically prevent this from ever being
    // directly converted to data
    using PodType = std::false_type;

    // Alias the leading header type
    using HdrType = HdrT;

    // Our argument type, collection of tuples
    using ArgsType = Tuple<Args...>;

    // Size of all the arguments
    _const auto Size = (0 + ... + sizeof(Args));
};

#pragma pack(pop)

}  // namespace engine::tag
