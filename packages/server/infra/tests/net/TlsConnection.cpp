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

#include "test.h"

#define HOST_NAME "www.google.com"
#define HOST_RESOURCE "/"
#define HOST_PORT_SECURE 443
#define HOST_PORT_INSECURE 80

TEST_CASE("net::Tls") {
    using namespace engine::net;

    auto logScope = enableTestLogging(Lvl::JobSearchBatch, Lvl::Tls);

    _const InternetConnection::Type types[2] = {
        InternetConnection::Type::Insecure,
        InternetConnection::Type::Secure,
    };

    _const int maxAttempts{5};

    for (auto type : types) {
        bool success{false};
        for (int i = 0; i < maxAttempts && !success; ++i) {
            if (i) async::sleep(1s * (2 * i + 1));

            InternetConnection connection{type};
            if (auto error = connection.connect(
                    HOST_NAME, connection.isSecure() ? HOST_PORT_SECURE
                                                     : HOST_PORT_INSECURE)) {
                LOG(Test, "Connection failure... will retry connection max",
                    i + 1, "of", maxAttempts, "times...", error);
                continue;
            }

            _const TextView rawData{"GET " HOST_RESOURCE
                                    " HTTP/1.1\r\nHost: " HOST_NAME
                                    "\r\nConnection: close\r\n\r\n"};
            *connection.write(memory::viewCast(rawData));

            Buffer recvData(256_kb);
            *connection.read(recvData);
            success = true;
        }
        REQUIRE(success);
    }
}
