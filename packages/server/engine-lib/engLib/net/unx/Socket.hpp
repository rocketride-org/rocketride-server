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

#include <sys/socket.h>
#include <netdb.h>
#include <sys/types.h>

namespace engine::net {

// This class implements the lowest level of the socket
class Socket final {
public:
    _const auto LogLevel = Lvl::Socket;

    _const auto InvalidSocket = -1;

    ~Socket() noexcept { close(); }

    // Send data on a socket
    Error write(memory::DataView<const uint8_t> data) noexcept {
        while (data) {
            LOGT("Write", data);

            // Send it (check for EINTR)
            _forever() {
                auto sentSize =
                    ::send(m_hSocket, data.cast<char>(), data.sizeAs<int>(), 0);
                // If it had a non-EINTR error, stop
                if (sentSize < 0) {
                    if (errno == EINTR && !async::cancelled()) {
                        LOGT("Send returned EINTR; retrying");
                        continue;
                    } else
                        return APERRT(errno, "send", data.size());
                }

                data.consumeSlice(sentSize);
                break;
            }
        }

        return {};
    }

    // Recv data form a socket
    Error read(BufferView data) const noexcept {
        while (data) {
            // Receive as much as we can (check for EINTR)
            _forever() {
                auto recvSize =
                    ::recv(m_hSocket, data.cast<char>(), data.sizeAs<int>(), 0);
                if (recvSize < 0) {
                    if (errno == EINTR && !async::cancelled()) {
                        LOGT("Receive returned EINTR; retrying");
                        continue;
                    } else
                        return APERRT(errno, "recv", data.size());
                }

                if (recvSize == 0) {
                    LOGT("Peer connection closed");
                    return {};
                }

                LOGT("Read", data.slice(recvSize));
                data.consumeSlice(recvSize);
                break;
            }
        }
        return {};
    }

    // Open a socket to the given address
    Error connect(const Text &address, uint16_t port) const noexcept {
        // Setup the getaddrinfo params
        struct addrinfo *rp = NULL, hints;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;

        LOGT("Getaddrinfo: {}:{}", address, port);

        // Resolve the server address and port
        struct addrinfo *result = nullptr;
        if (auto socketStatus =
                ::getaddrinfo(address, _ts(port), &hints, &result))
            return APERRT(errno, "getaddrinfo", address, port);

        auto releaseGuard =
            util::Guard{[&]() noexcept { ::freeaddrinfo(result); }};

        // getaddrinfo returns a list of address structures.
        // Try each address until we successfully connect.
        // If socket call fails, close the socket and try the
        // next address.
        Error ccode;
        for (rp = result; rp != NULL; rp = rp->ai_next) {
            auto sfd =
                ::socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
            if (sfd == -1) continue;

            auto closeGuard = util::Guard{[&]() noexcept { ::close(sfd); }};

            // Set a long timeout
            // tv_sec is number of whole seconds of elapsed time
            struct timeval timeout;
            timeout.tv_sec = 60 * 5;
            timeout.tv_usec = 0;

            int iResult;

            // Set send
            iResult = ::setsockopt(sfd, SOL_SOCKET, SO_RCVTIMEO,
                                   (char *)&timeout, sizeof(timeout));
            if (iResult) APERRL(Error, errno, "setsockopt SO_RCVTIMEO");

            // Set recv
            iResult = ::setsockopt(sfd, SOL_SOCKET, SO_SNDTIMEO,
                                   (char *)&timeout, sizeof(timeout));
            if (iResult) APERRL(Error, errno, "setsockopt SO_SNDTIMEO");

            // check the options were set correctly - recieve
            struct timeval timeoutGetRec;
            struct timeval timeoutGetSend;
            {
                socklen_t optLen = sizeof(timeoutGetRec);
                iResult = ::getsockopt(sfd, SOL_SOCKET, SO_RCVTIMEO,
                                       (char *)&timeoutGetRec, &optLen);

                if (iResult)
                    APERRL(Error, errno, "getsockopt SO_RCVTIMEO failed");
            }

            // check the options were set correctly - send
            {
                socklen_t optLen = sizeof(timeoutGetSend);
                iResult = ::getsockopt(sfd, SOL_SOCKET, SO_SNDTIMEO,
                                       (char *)&timeoutGetSend, &optLen);

                if (iResult)
                    APERRL(Error, errno, "getsockopt SO_SNDTIMEO failed");
            }
            // Verify timeouts are what we want them to be
            if (timeoutGetRec.tv_sec != timeout.tv_sec ||
                timeoutGetSend.tv_sec != timeout.tv_sec)
                APERRL(Error, errno,
                       "Timeouts on socket were not set properly");

            // After sockets option are defined establish connection (check for
            // EINTR)
            int connectResult = {};
            _forever() {
                connectResult = ::connect(sfd, rp->ai_addr, rp->ai_addrlen);
                if (connectResult < 0 && errno == EINTR) {
                    LOGT("Connect returned EINTR; retrying");
                    continue;
                }
                break;
            }

            if (connectResult) {
                ccode = APERRT(errno, "connect", address, port);
                continue;
            }

            m_hSocket = sfd;
            closeGuard.cancel();
            break;
        }

        if (!ccode) {
            ASSERT(m_hSocket != InvalidSocket);
        }

        return ccode;
    }

    // Close a socket
    void close() const noexcept {
        // If the socket is not open, done
        if (m_hSocket != InvalidSocket) {
            ::shutdown(m_hSocket, SHUT_RDWR);
            ::close(m_hSocket);
            m_hSocket = InvalidSocket;
        }
    }

private:
    // Holds the socket handle
    mutable int m_hSocket = InvalidSocket;
};

}  // namespace engine::net
