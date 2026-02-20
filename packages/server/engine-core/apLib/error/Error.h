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
// Defines the Error representation. The Error has a code, and optionally,
// an associated error message.
class Error : public std::exception {
public:
    Error() = default;
    ~Error() = default;

    Error(const Error& src) = default;
    Error(Error&& src) = default;
    Error& operator=(const Error&) = default;
    Error& operator=(Error&&) = default;

    template <typename Code, typename... Msg>
    Error(Code errorCode, Location location, Msg&&... msg) noexcept;

    template <typename Code>
    Error(Code errorCode, Location location) noexcept;

    Error(const Error& errorCode, Location location) noexcept
        : Error(errorCode.m_code, location) {
        makeChain(_mv(errorCode));
    }

    template <typename... Msg>
    Error(const Error& errorCode, Location location, Msg&&... msg) noexcept
        : Error(errorCode.m_code, location, std::forward<Msg>(msg)...) {
        makeChain(errorCode);
    }

    Error(Error&& errorCode, Location location) noexcept
        : m_code(errorCode.m_code),
          m_message(_mv(errorCode.m_message)),
          m_trace(_mv(errorCode.m_trace)),
          m_cachedWhat(_mv(errorCode.m_cachedWhat)),
          m_chain(_mv(errorCode.m_chain)),
          m_location(location ? location : errorCode.m_location) {}

    template <typename... Msg>
    Error(Error&& errorCode, Location location, Msg&&... msg) noexcept
        : Error(errorCode.m_code, location, std::forward<Msg>(msg)...) {
        makeChain(_mv(errorCode));
    }

    bool isSet() const noexcept { return _cast<bool>(m_code); }

    explicit operator bool() const noexcept { return isSet(); }

    TextView message() const noexcept {
        if (m_message) return m_message.value();
        return {};
    }

    Location location() const noexcept { return m_location; }

    operator ErrorCode() const noexcept { return m_code; }
    ErrorCode code() const noexcept { return m_code; }
    int plat() const noexcept { return m_code.value(); }
    template <typename T>
    T codeAs() const noexcept {
        return _cast<T>(plat());
    }

    template <typename ErrC>
    bool operator==(ErrC errc) const noexcept {
        return m_code == make_error_code(errc);
    }

    template <typename ErrC>
    bool operator!=(ErrC errc) const noexcept {
        return m_code != make_error_code(errc);
    }

    bool operator==(const Error& ccode) const noexcept {
        return m_code == ccode.m_code;
    }
    bool operator!=(const Error& ccode) const noexcept {
        return m_code != ccode.m_code;
    }

    bool operator==(const ErrorCode& code) const noexcept {
        return m_code == code;
    }
    bool operator!=(const ErrorCode& code) const noexcept {
        return m_code != code;
    }

    const Error& operator||(const Error& ccode) const noexcept {
        if (m_code) return *this;
        return ccode;
    }

    Error& operator|=(const Error& ccode) noexcept {
        if (!m_code && ccode) *this = ccode;
        return *this;
    }

    void reset() noexcept {
        m_code = {};
        m_location = {};
        m_message.reset();
        m_chain.reset();
        m_cachedWhat.reset();
    }

    auto checkThrow() const noexcept(false) {
        if (*this) throw *this;
    }

    // Throws error if set or "unset error" bug otherwise
    void rethrow() const noexcept(false) {
        checkThrow();
        throw Error(Ec::Bug, _location, "No ccode present");
    }

    // This alias for check throw allows us to use Error and
    // ErrorOr throw semantics with the same syntax
    void operator*() noexcept(false) { checkThrow(); }

    // String render method, picked up by the convert apis
    template <typename Buffer>
    void __toString(Buffer& buff, FormatOptions opts) const noexcept;

    template <typename Json>
    void __toJson(Json& val) const noexcept;

    // Adhere to std::exception api
    const char* what() const noexcept override {
        if (!m_cachedWhat) m_cachedWhat = _ts(*this);
        return m_cachedWhat->c_str();
    }

    Text trace() const noexcept {
        if (m_trace) return _ts(*m_trace);
        return {};
    }

    // Access the next error in the chain
    auto next() const noexcept { return m_chain; }

    // Access the root error in the chain (this is the one that started all the
    // trouble)
    const auto& root() const noexcept {
        if (!m_chain) return *this;
        auto next = m_chain;
        for (; next && next->m_chain; next = next->m_chain) {
        }
        return *next;
    }

protected:
    void makeChain(const Error& chain) noexcept;
    void makeChain(Error&& chain) noexcept;

    template <typename Buffer>
    static void toString(const Error& ccode, Buffer& buff, FormatOptions opts,
                         uint32_t index = 0) noexcept;

    ErrorCode m_code;
    mutable Opt<Text> m_message;
    mutable Opt<dev::Backtrace> m_trace;
    // For what() support, holds the last rendered string
    mutable Opt<Text> m_cachedWhat;
    // Chain of errors leading up to this one
    SharedPtr<const Error> m_chain;
    Location m_location;
};

}  // namespace ap

namespace std {

inline auto make_error_code(const error_code& error) noexcept { return error; }

}  // namespace std
