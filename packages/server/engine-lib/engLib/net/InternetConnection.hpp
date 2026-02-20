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

namespace engine::net {

// Wraps both platform specific Socket implementation and TLS connection
// implementation in a wrapper class to unify access to both classes which
// yields direct access to one or the other based on a simple secure
// or insecure enumeration.
class InternetConnection final {
public:
    enum class Type {
        Secure,
        Insecure,
    };

    InternetConnection(Type type) noexcept {
        if (Type::Secure == type) {
            m_underlyingType.emplace<TlsConnection>();
        } else {
            m_underlyingType.emplace<Socket>();
        }
    }

    Error connect(const Text &address, uint16_t port,
                  const TlsConnection::Options options = {}) const noexcept {
        return _visit(overloaded{[&](const Socket &type) noexcept {
                                     return type.connect(address, port);
                                 },
                                 [&](const TlsConnection &type) noexcept {
                                     return type.connect(address, port,
                                                         options);
                                 }},
                      m_underlyingType);
    }

    Error read(OutputData data) const noexcept {
        return _visit(
            overloaded{[&](const Socket &type) noexcept {
                           return type.read(std::forward<decltype(data)>(data));
                       },
                       [&](const TlsConnection &type) noexcept {
                           return type.read(std::forward<decltype(data)>(data));
                       }},
            m_underlyingType);
    }

    Error write(InputData data) noexcept {
        return _visit(
            overloaded{
                [&](Socket &type) noexcept {
                    return type.write(std::forward<decltype(data)>(data));
                },
                [&](TlsConnection &type) noexcept {
                    return type.write(std::forward<decltype(data)>(data));
                }},
            m_underlyingType);
    }

    void close() const noexcept {
        return _visit(
            overloaded{[](const Socket &type) noexcept { return type.close(); },
                       [](const TlsConnection &type) noexcept {
                           return type.close();
                       }},
            m_underlyingType);
    }

    constexpr bool isSecure() const noexcept {
        return nullptr != std::get_if<TlsConnection>(&m_underlyingType);
    }

    constexpr Type type() const noexcept {
        return isSecure() ? Type::Secure : Type::Insecure;
    }

private:
    Variant<Socket, TlsConnection> m_underlyingType;
};

}  // namespace engine::net
