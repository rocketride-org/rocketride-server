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

namespace engine::net {

// This class implements the lowest level of the socket
class Socket final {
public:
    _const auto LogLevel = Lvl::Socket;

    ~Socket() noexcept { close(); }

    // Send data on a socket
    Error write(memory::DataView<const uint8_t> data) noexcept {
        while (data) {
            LOGT("Write", data);

            // Send it
            auto sentSize =
                ::send(m_hSocket, data.cast<char>(), data.sizeAs<int>(), 0);

            // If it had an error, stop
            if (sentSize == SOCKET_ERROR)
                return APERRT(::WSAGetLastError(), "send", data.size());

            data.consumeSlice(sentSize);
        }

        return {};
    }

    // Recv data form a socket
    Error read(BufferView data) const noexcept {
        while (data) {
            // Receive as much as we can
            auto recvSize =
                ::recv(m_hSocket, data.cast<char>(), data.sizeAs<int>(), 0);

            if (recvSize == SOCKET_ERROR)
                return APERRT(::WSAGetLastError(), "recv", data.size());

            if (recvSize == 0) {
                LOGT("Peer connection closed");
                break;
            }

            LOGT("Read", data.slice(recvSize));

            data.consumeSlice(recvSize);
        }
        return {};
    }

    // Open a socket to the given address
    Error connect(const Text &address, uint16_t port,
                  const json::Value &options = {}) const noexcept {
        LOGT("Connecting to: {}:{}", address, port);

        // Setup the getaddrinfo params
        struct addrinfo hints;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;

        // Resolve the server address and port
        struct addrinfo *result = nullptr;
        if (auto socketStatus =
                ::getaddrinfo(address, _ts(port), &hints, &result))
            return APERRT(socketStatus, "Unable to getaddrinfo");
        auto guard =
            util::Scope{[&result]() noexcept { ::freeaddrinfo(result); }};

        // Create a SOCKET for connecting to server
        m_hSocket =
            socket(result->ai_family, result->ai_socktype, result->ai_protocol);

        // Check to make sure it opened
        if (m_hSocket == INVALID_SOCKET)
            return APERRT(::WSAGetLastError(), "Unable to open socket");

        // Connect it
        if (auto socketStatus = ::connect(m_hSocket, result->ai_addr,
                                          (int)result->ai_addrlen)) {
            // Close the socket
            closesocket(m_hSocket);
            m_hSocket = INVALID_SOCKET;

            // Get the error code - if it indicates no error, then set it to one
            auto code = ::WSAGetLastError();
            if (!code) code = WSAEHOSTUNREACH;

            // Return the error
            return APERRT(code, "Unable to connect socket", address, port);
        }

        // Release the address info
        guard.exec();

        // Set a long timeout for tcp
        int iResult;
        DWORD timeout = 5 * 60;

        DWORD setParam = timeout;
        iResult = ::setsockopt(m_hSocket, IPPROTO_TCP, TCP_MAXRT,
                               (char *)&setParam, sizeof(setParam));
        if (iResult == SOCKET_ERROR)
            LOGT("Failed to set socket option",
                 Error{WSAGetLastError(), _location});

        // Get the size actually set
        DWORD getParam;
        int optLen = sizeof(getParam);
        iResult = ::getsockopt(m_hSocket, IPPROTO_TCP, TCP_MAXRT,
                               (char *)&getParam, &optLen);
        if (iResult == SOCKET_ERROR)
            LOGT("Failed to get option", Error{WSAGetLastError(), _location});

        // Verify timeout us correct
        if (getParam != timeout)
            LOGT("Timeout not set properly",
                 Error{WSAGetLastError(), _location});

        return {};
    }

    // Close a socket
    void close() const noexcept {
        // If the socket is not open, done
        if (m_hSocket == INVALID_SOCKET) return;

        // Flush - preserve error, only set if we got an error directly
        ::shutdown(m_hSocket, SD_BOTH);

        // Close socket - preserve error, only set if we got an error directly
        ::closesocket(m_hSocket);

        // Clear the socket
        m_hSocket = INVALID_SOCKET;
    }

private:
    // Holds the socket handle
    mutable SOCKET m_hSocket = INVALID_SOCKET;
};

}  // namespace engine::net
