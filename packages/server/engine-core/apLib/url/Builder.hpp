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

namespace ap::url {

// Helper class to manufacture a Url
// example: Url path = Builder{} << Protocol("dataFile:") <<
// Authority("10.1.1.2") << Path("file.dat")
struct Builder final {
    Builder() = default;
    Builder(const Builder&) = default;
    Builder(Builder&&) = default;

    Text finalize() const noexcept {
        Text url;
        ASSERTD_MSG(m_protocol, "URL missing protocol");

        // If we have an authority, append it
        if (hasAuthority()) {
            // Add the authority
            url += m_authority;
        }

        // Add the path if we have one
        if (m_path) {
            // Append / if needed
            if (url.size()) url += "/";

            // If we have a path, we did not add an authority, so
            // append it after trimming leading and trailing '/'s
            url += string::trim(m_path.gen(), {'/'});
        }

        // Add the protocol
        url = string::trimTrailing(m_protocol, {'/', ':'}) + "://" + url;

        // Append query string
        if (!m_parameters.empty()) url += '?' + _tsd<'&'>(m_parameters);

        // And return it
        return url;
    }

    operator Text() const { return finalize(); }

    // We define the uri explicit types as rvalues to prevent usage outside of a
    // direct
    // << stream operator from a temp var
    decltype(auto) operator<<(Protocol&& protocol) noexcept {
        m_protocol = _mv(protocol);
        return *this;
    }

    // Render the URL as if it had an authority, i.e. always use "://"
    decltype(auto) operator<<(ProtocolWithoutAuthority&& protocol) noexcept {
        m_protocol = _mv(protocol);
        m_withoutAuthority = true;
        return *this;
    }

    decltype(auto) operator<<(Authority&& authority) noexcept {
        m_authority = _mv(authority);
        return *this;
    }

    decltype(auto) operator<<(Component&& component) noexcept {
        m_path /= component;
        return *this;
    }

    decltype(auto) operator<<(const file::Path& path) noexcept {
        m_path /= path;
        return *this;
    }

    template <typename T>
    decltype(auto) operator<<(ParameterValue<T>&& attrib) noexcept {
        auto v = _ts(attrib.val);
        auto [iter, inserted] = m_parameters.emplace(
            makePair(_mv(attrib.key), encode(_ts(attrib.val))));
        ASSERTD_MSG(inserted, "Duplicate URL query parameter", iter->first);
        return *this;
    }

    decltype(auto) operator<<(const End& end) noexcept { return finalize(); }

private:
    bool hasAuthority() const noexcept {
        if (m_withoutAuthority) {
            // Both should not be used together
            ASSERT(!m_authority);
            return true;
        }

        return !m_authority.empty();
    }

private:
    Text m_protocol;
    Text m_authority;
    bool m_withoutAuthority = {};
    file::Path m_path;
    std::map<Text, Text> m_parameters;
};

}  // namespace ap::url
