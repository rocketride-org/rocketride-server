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

namespace engine::tag {

// Writes a header to an output with any number of data args
// The data args will be converted to data and their size will be set in the
// header
template <typename HdrT, typename OutT, typename... Args>
inline void write(memory::adapter::Output<OutT>& out,
                  const Args&... args) noexcept(false) {
    // Write the header out first
    out.write(HdrT{});

    // Write the args
    *_tdb(out, args...);
}

// Validates the args against a data definition header, then writes the header
// and the args to an output
template <typename HdrDataT, typename OutT, typename... Args>
inline void writeData(memory::adapter::Output<OutT>& out,
                      const Args&... args) noexcept(false) {
    // Validate the args
    static_assert(IsHdrDataV<HdrDataT>);
    static_assert(
        std::is_constructible_v<typename HdrDataT::ArgsType, Args...>);

    // Write the tag and the args to the output
    return write<typename HdrDataT::HdrType>(out, args...);
}

// Validates the args against a data definition header, then writes the args to
// an output
template <typename HdrDataT, typename OutT, typename... Args>
inline auto writeDataArgs(memory::adapter::Output<OutT>& out,
                          const Args&... args) noexcept(false) {
    // Validate the args
    static_assert(IsHdrDataV<HdrDataT>);
    static_assert(
        std::is_constructible_v<typename HdrDataT::ArgsType, Args...>);

    // Write the args
    *_tdb(out, args...);
}

// Skips a header and its data
template <typename HdrT, typename InT>
inline HdrT skip(const memory::adapter::Input<InT>& in) noexcept(false) {
    HdrT hdr;
    *_fda(in, hdr);
    // Verify the header being skipped is of the expected class
    if constexpr (!IsHdrDataV<HdrT>) hdr.__validate();
    return hdr;
}

// Read two headers, skips Hdr1 (expects it to have no data), then reads Hdr2
// if either of these headers aren't found it will throw an error
template <typename SkipHdrT, typename ReadHdrT, typename InT>
inline Pair<SkipHdrT, ReadHdrT> skipRead(
    const memory::adapter::Input<InT>& in) noexcept(false) {
    auto skipHdr = *_fd<SkipHdrT>(in);
    return {skipHdr, *_fd<ReadHdrT>(in)};
}

template <typename HdrT>
inline auto nameOf() noexcept {
    if constexpr (IsHdrDataV<HdrT>)
        return HdrT::HdrType::name();
    else
        return HdrT::name();
}

template <typename HdrT>
inline auto cast(const GenericHdr& hdr) noexcept {
    if constexpr (IsHdrDataV<HdrT>)
        return hdr.template cast<typename HdrT::HdrType>();
    else
        return hdr.template cast<HdrT>();
}

template <typename ToT, typename FromT>
inline auto expect(const FromT& hdr) noexcept(false) {
    if (!cast<ToT>(hdr))
        APERR_THROW(Ec::TagInvalidHdr, "Expected header", nameOf<ToT>());
    LOG(Tag, "Skip", nameOf<ToT>());
}

// Parse the tag arguments from an already read header
template <typename HdrDataT, typename InT>
inline auto readDataArgs(const memory::adapter::Input<InT>& in) noexcept(
    false) {
    static_assert(IsHdrDataV<HdrDataT>);

    // Setup the argument types from the data definition
    using Hdr = typename HdrDataT::HdrType;
    typename HdrDataT::ArgsType args;

    util::tuple::forEach(args, [&](auto& arg) { *_fda(in, arg); });
    return args;
}

// Read one block of data
template <typename HdrDataT, typename InT,
          typename AllocatorT = std::allocator<uint8_t>>
inline auto readData(const memory::adapter::Input<InT>& in,
                     const AllocatorT& alloc = {}) noexcept(false) {
    // If its a data header, it contains the type info we need as a tuple
    // otherwise we will assume a raw Data<uint8_t> for the associated data
    if constexpr (IsHdrDataV<HdrDataT>) {
        // Setup the argument types from the data definition
        using Hdr = typename HdrDataT::HdrType;

        // Read the next header as a generic
        auto hdr = *_fd<GenericHdr>(in);

        // If we read the data header, read the args next
        if (auto h = hdr.template cast<Hdr>()) {
            LOG(Tag, "ReadData", Hdr::name());
            return readDataArgs<HdrDataT>(in);
        }

        // Unexpected header, error
        APERR_THROW(Ec::TagInvalidHdr, "Failed to read valid data header",
                    Hdr::name());
    } else {
        // Construct the data header, it has slots for the result ready to go
        using Hdr = HdrDataT;
        memory::Data<uint8_t, AllocatorT> data(alloc);

        // Read the next header as a generic
        auto hdr = *_fd<GenericHdr>(in);

        // If we read the data header, read the args next
        if (hdr.template cast<Hdr>()) {
            LOG(Tag, "ReadData", Hdr::name());
            *_fda(in, data);

            // Read the data
            return data;
        }

        // Unexpected header, error
        APERR_THROW(Ec::TagInvalidHdr, "Failed to read valid data header",
                    Hdr::name());
    }
}

}  // namespace engine::tag
