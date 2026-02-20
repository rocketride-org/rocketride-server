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

namespace ap {

class Uuid {
public:
    using UnderlyingType = boost::uuids::uuid;

    Uuid() = default;

    Uuid(Uuid &&uuid) = default;
    Uuid &operator=(Uuid &&uuid) = default;

    Uuid(const Uuid &uuid) = default;
    Uuid &operator=(const Uuid &uuid) = default;

    Uuid(UnderlyingType uuid) noexcept : m_uuid(uuid) {}

    bool operator<(const Uuid &uuid) const noexcept {
        ASSERT(m_uuid && uuid);
        return m_uuid.value() < uuid.m_uuid.value();
    }

    bool operator==(const Uuid &uuid) const noexcept {
        if (!uuid.m_uuid || !m_uuid) return false;
        return uuid.m_uuid.value() == m_uuid.value();
    }

    bool operator!=(const Uuid &uuid) const noexcept {
        return operator==(uuid) == false;
    }

    explicit operator bool() const noexcept {
        return static_cast<bool>(m_uuid);
    }

    static auto create() noexcept {
        static boost::uuids::random_generator generator = {};
        return Uuid{generator()};
    }

    template <typename Buffer>
    void __toString(Buffer &buff) const noexcept {
        if (m_uuid) _tsb(buff, m_uuid.value());
    }

    template <typename Buffer>
    static Error __fromString(Uuid &uuid, const Buffer &buff) noexcept {
        auto res = error::call(_location, [&] {
            uuid.m_uuid = boost::lexical_cast<UnderlyingType>(buff.toString());
        });
        if (res.check()) return _mv(res.ccode());
        return {};
    }

private:
    Opt<UnderlyingType> m_uuid;
};

}  // namespace ap
