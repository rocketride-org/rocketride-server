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

// A connection provides a rpc based api for communicating with a remote
// rocketride service
class Connection {
public:
    // Our log level
    _const auto LogLevel = Lvl::Connection;

    using Type = InternetConnection::Type;

    // Default construction
    Connection() noexcept = default;

    // Do not allow object copy
    Connection &operator=(const Connection &) noexcept = delete;
    Connection &operator=(Connection &&) noexcept = delete;

    // Connect on construction, throws
    Connection(Text address, uint16_t port, bool useSecureSocket,
               TlsConnection::Options opts = {}) noexcept(false)
        : m_address(_mv(address)),
          m_port(port),
          m_connectionType(useSecureSocket ? Type::Secure : Type::Insecure),
          m_tlsOptions(_mv(opts)) {
        *connect();
    }

    // Connect to a new address
    Error connect(Text address, uint16_t port, bool useSecureSocket,
                  TlsConnection::Options opts = {}) noexcept {
        m_address = _mv(address);
        m_port = port;
        m_connectionType = (useSecureSocket ? Type::Secure : Type::Insecure);
        m_tlsOptions = _mv(opts);
        return connect();
    }

    // Connect (or re-connect) to the last address
    Error connect() noexcept {
        auto lock = m_lock.lock();

        // Setup our identify for executeBy
        m_executeBy =
            _ts(config::nodeId(false), ":Engine:", async::processId());

        m_connection.emplace(m_connectionType);
        if (auto ccode = m_connection->connect(m_address, m_port, m_tlsOptions))
            return ccode;

        m_connectionId = _ts(Uuid::create());

        auto reply =
            submit<Identify>(plat::hostName(), "engine",
                             _tso({Format::HEX, 0, '-'}, config::nodeId(),
                                  async::processId(), m_nextId++));
        if (!reply) return reply.ccode();

        // Identified successfully, stash the ident reply info
        m_identReply = _mv(reply->data);

        LOGT("Identified peer", m_identReply);
        return {};
    }

    // Submit an rpc request without data to the appliance
    template <typename T, typename... Args>
    ErrorOr<RplPacket<T>> submit(Args &&...args) noexcept {
        RquPacket<T> rqu{
            typename RquPacket<T>::PacketType{m_connectionId,
                                              m_executeBy,
                                              "appliance",
                                              {std::forward<Args>(args)...}}};
        return submitRequest<T>(rqu);
    }

    // Submit an rpc request with data to the appliance
    template <typename T, typename... Args>
    ErrorOr<RplPacket<T>> submitData(memory::DataView<const uint8_t> data,
                                     Args &&...args) noexcept {
        RquPacket<T> rqu{
            typename RquPacket<T>::PacketType{m_connectionId,
                                              m_executeBy,
                                              "appliance",
                                              {std::forward<Args>(args)...}},
            _mv(data)};
        return submitRequest<T>(rqu);
    }

    // Submit an rpc request without data to the given target
    template <typename T, typename... Args>
    ErrorOr<RplPacket<T>> submitOn(TextView executeOn,
                                   Args &&...args) noexcept {
        RquPacket<T> rqu{
            typename RquPacket<T>::PacketType{m_connectionId,
                                              m_executeBy,
                                              executeOn,
                                              {std::forward<Args>(args)...}}};
        return submitRequest<T>(rqu);
    }

    // Submit an rpc request with data to the appliance
    template <typename T, typename... Args>
    ErrorOr<RplPacket<T>> submitDataOn(TextView executeOn,
                                       memory::DataView<const uint8_t> data,
                                       Args &&...args) noexcept {
        RquPacket<T> rqu{
            typename RquPacket<T>::PacketType{m_connectionId,
                                              m_executeBy,
                                              executeOn,
                                              {std::forward<Args>(args)...}},
            _mv(data)};
        return submitRequest<T>(rqu);
    }

    // Access peer identity info
    decltype(auto) identInfo() const noexcept { return m_identReply; }

    // Log prefix
    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << m_connectionId << "[" << m_address << ":" << m_port << "]";
    }

private:
    // Submit a prepared request packet
    template <typename T>
    ErrorOr<RplPacket<T>> submitRequest(const RquPacket<T> &rqu) noexcept {
        auto res = rqu.marshal();
        if (!res) return res.ccode();
        auto [hdr, payload, data] = _mv(*res);

        auto lock = m_lock.lock();
        LOGT("Sending request", hdr, payload);

        // Write the header, payload, data
        if (auto ccode = m_connection->write(_ts(hdr)))
            return APERRT(ccode, "Failed to write request header", hdr,
                          payload);

        if (auto ccode = m_connection->write(payload))
            return APERRT(ccode, "Failed to write request payload", hdr,
                          payload);

        if (auto ccode = m_connection->write(rqu.data()))
            return APERRT(ccode, "Failed to write request data", hdr, payload,
                          data.size());

        // Now we expect a reply
        auto reply = readReply<T>(hdr.id);
        if (!reply)
            return APERRT(reply.ccode(), "Failed to read reply", hdr, payload);

        LOGT("Reply", hdr, reply);

        return reply;
    }

    // Reads a reply
    template <typename T>
    ErrorOr<RplPacket<T>> readReply(uint32_t requestId) noexcept {
        // The payload is temporary so we'll use the stack, just need it
        // long enough to parse the json value from it
        StackText arena;
        StackText packetHdr{arena};
        StackText payload{arena};

        // We want the data on the heap so we can move it into place
        Buffer data;

        // Read the raw bytes of the header
        packetHdr.resize(PacketHdrSize);
        if (auto ccode = m_connection->read(packetHdr))
            return APERRT(ccode, "Failed to read packet header");

        // Parse it
        auto hdr = _fsc<ReplyHdr>(packetHdr);
        if (!hdr)
            return APERRT(hdr.ccode(), "Failed to parse reply header",
                          packetHdr);

        // These better match
        if (hdr->id != requestId)
            return APERRT(Ec::InvalidRpc, "Command id mismatch", requestId,
                          hdr);

        // Now we know how much there is to read in the reply, read it in two
        // chunks
        payload.resize(hdr->length);

        LOGT("Read reply", hdr, payload);

        // First the json
        if (auto ccode = m_connection->read(payload))
            return APERRT(ccode, "Failed to read reply payload", hdr);

        // Now the data
        data.resize(hdr->dataLength);

        if (auto ccode = m_connection->read(data))
            return APERRT(ccode, "Failed to read reply data");

        // Ok we got the json in one section and the data in the other
        // parse the result
        return RplPacket<T>::parse(*hdr, payload, _mv(data));
    }

private:
    // Our connection id, generated on connect
    Text m_connectionId;

    // Peer info from the identify request
    IdentifyParam::Reply m_identReply;

    // Platform specific socket api or secure connection
    Opt<InternetConnection> m_connection;

    // Unique id incremented and appended to nodeId field on identify
    _inline Atomic<uint32_t> m_nextId = {};

    // Lock to guard against concurrent access
    async::MutexLock m_lock;

    // Address info
    Text m_executeBy;
    Text m_address;
    uint16_t m_port = {};
    Type m_connectionType;
    TlsConnection::Options m_tlsOptions;
};

}  // namespace engine::net::rpc
