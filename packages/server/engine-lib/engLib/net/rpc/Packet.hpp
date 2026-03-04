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

namespace engine::net::rpc {

// Fixed byte count for headers
_const Size PacketHdrSize = 36;

// Simple global counter for handing out command ids
inline uint32_t nextId() noexcept {
    static Atomic<uint32_t> nextId = {1};
    return nextId++;
}

// Request/reply header is:
//	@PDU:ttt:########:xxxxxxxx:yyyyyyyy@
//		ttt			3 type
//		########	8 command id
//		xxxxxxxx	8 length of the command
//		yyyyyyyy	8 length of the binary data following the command
//	all values are in hex
template <Type RpcType>
struct PacketHdr {
    // Forward our rpc type as a constant
    _const auto type = RpcType;

    // Convert this hdr to a string, this creates the wire protocol format
    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        if (auto ccode =
                _tsbo(buff, {Format::HEX | Format::FILL, {}, ':'}, "@PDU", type,
                      _cast<uint32_t>(id), _cast<uint32_t>(length),
                      _cast<uint32_t>(dataLength)))
            return ccode;
        buff << '@';
        return Error{};
    }

    // Parse the wire protocol format string
    template <typename Buffer>
    static Error __fromString(PacketHdr& hdr, const Buffer& buff) noexcept {
        auto str = buff.toView();
        if (str.size() != PacketHdrSize || !str.startsWith("@PDU:") ||
            !str.endsWith('@'))
            return APERR(Ec::InvalidRpc, "Invalid rpc header", str);

        // Trim the leading @PDU: and trailing @ from the view
        str.remove_prefix(5);
        str.remove_suffix(1);

        // Break it up at the expected offsets, and convert to our concrete
        // types
        size_t pos = 0;
        for (auto len : {3, 8, 8, 8}) {
            auto comp = str.substr(pos, len);
            switch (pos) {
                case 0: {
                    if (hdr.type == Type::RQU && !comp.equals("RQU", false) ||
                        hdr.type == Type::RPL && !comp.equals("RPL", false))
                        return APERR(Ec::InvalidRpc, "Invalid rpc header", str);
                    break;
                }

                case 4: {
                    auto id = _fsc<uint32_t>(comp, Format::HEX);
                    if (!id) return id.ccode();
                    hdr.id = *id;
                    ;
                    break;
                }

                case 13: {
                    auto length = _fsc<uint32_t>(comp, Format::HEX);
                    if (!length) return length.ccode();
                    hdr.length = *length;
                    break;
                }

                case 22: {
                    auto dataLength = _fsc<uint32_t>(comp, Format::HEX);
                    if (!dataLength) return dataLength.ccode();
                    hdr.dataLength = *dataLength;
                    break;
                }

                default:
                    ASSERT_MSG(false, "Should not get here");
                    break;
            }

            // Skip the thing we just parsed
            pos += len;

            // Skip the colon
            pos++;
        }

        return {};
    }

    // Main attributes of a header are pretty fundamental, it just describes
    // the lengths and the commandid (for handling multiple active commands
    // on a single connection)
    size_t length = {};
    size_t dataLength = {};
    uint32_t id = nextId();
};

// Alias concrete types for request/reply headers
using RequestHdr = PacketHdr<Type::RQU>;
using ReplyHdr = PacketHdr<Type::RPL>;

// A packet is a logical command and generically provides
// parsing and marshaling logic for a compose request
// or reply
template <Type RpcType, typename PacketTypeT>
class Packet : public PacketHdr<RpcType> {
public:
    using Parent = PacketHdr<RpcType>;
    using HeaderType = PacketHdr<RpcType>;
    using PacketType = PacketTypeT;

    _const auto IsRqu = RpcType == Type::RQU;
    _const auto IsRpl = RpcType == Type::RPL;

    // Requests use views, replies use data's
    using DataViewType = memory::DataView<const uint8_t>;
    using DataType = std::conditional_t<IsRqu, DataViewType, Buffer>;

    Packet() = default;

    Packet(HeaderType hdr, PacketType&& cmd, DataType&& data) noexcept
        : Parent(_mv(hdr)), m_cmd(_mv(cmd)), m_data(_mv(data)) {}

    Packet(PacketType&& cmd) noexcept : m_cmd(_mv(cmd)) {}

    Packet(PacketType&& cmd, DataType&& data) noexcept
        : m_cmd(_mv(cmd)), m_data(_mv(data)) {}

    decltype(auto) operator->() const noexcept { return &m_cmd; }

    decltype(auto) operator->() noexcept { return &m_cmd; }

    memory::DataView<const uint8_t> data() const noexcept { return m_data; }

    memory::DataView<const uint8_t> data() noexcept { return m_data; }

    // Parse extracts a packet from a header, payload, and optionally some data
    static ErrorOr<Packet> parse(HeaderType hdr, TextView payload,
                                 DataType data = {}) noexcept {
        if (hdr.length != payload.size())
            return APERR(Ec::InvalidRpc, "Payload size mismatch",
                         payload.size(), hdr.length);
        if (hdr.dataLength != data.size())
            return APERR(Ec::InvalidRpc, "Data size mismatch", data.size(),
                         hdr.dataLength);

        auto cmdVal = json::parse(payload);
        if (!cmdVal) return cmdVal.ccode();

        auto cmd = _fjc<PacketType>(*cmdVal);
        if (!cmd) return cmd.ccode();

        return Packet{hdr, _mv(*cmd), _mv(data)};
    }

    // Marshal prepares a header, a payload, and moves the caller data view out
    using ParseResult = Tuple<HeaderType, Text, DataViewType>;
    ErrorOr<ParseResult> marshal(Opt<uint32_t> id = {}) const noexcept {
        auto payloadVal = _tjc(m_cmd);
        if (!payloadVal) return payloadVal.ccode();
        auto payload = payloadVal->stringify(false);
        HeaderType hdr;
        hdr.id = id.value_or(nextId());
        hdr.length = payload.size();
        hdr.dataLength = m_data.size();
        return ParseResult{hdr, _mv(payload), m_data};
    }

    // Render a packet as a stirng, forward the render to render the command
    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        Parent::__toString(buff);
        _tsbo(buff, Format::JSONOK, m_cmd);
        _tsb(buff, m_data);
    }

private:
    PacketType m_cmd;
    DataType m_data;
};

// Alias concrete templates for the two main types
template <typename T>
using RplPacket = Packet<Type::RPL, typename T::Reply>;

template <typename T>
using RquPacket = Packet<Type::RQU, typename T::Request>;

}  // namespace engine::net::rpc
