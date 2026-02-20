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
// Void specialization of ErrorOr
template <>
class ErrorOr<void> : public std::variant<std::monostate, Error> {
public:
    // Alias our base class
    using Parent = std::variant<std::monostate, Error>;

    // Publically declare our primary result type
    using ResultType = void;

    // Use our bases constructors
    using Parent::Parent;

    // So we can be used as if we were a unique ptr
    using element_type = void;

    decltype(auto) ccode() const & noexcept(false) {
        if (!holds<Error>(*this))
            throw APERR(Ec::Bug, "Access of ccode when no ccode present");
        return std::get<Error>(*this);
    }

    decltype(auto) ccode() && noexcept(false) {
        if (!holds<Error>(*this))
            throw APERR(Ec::Bug, "Access of ccode when no ccode present");
        return _mv(std::get<Error>(*this));
    }

    bool hasCcode() const noexcept {
        return holds<Error>(*this) && ccode().isSet();
    }

    // Returns the ccode if set or the global singleton
    const Error &check() const noexcept {
        if (hasCcode()) return ccode();
        return internal::NoErrSingleton();
    }

    // This alias for check throw allows us to use Error and
    // ErrorOr<void> throw semantics with the same syntax
    void operator*() noexcept(false) { checkThrow(); }

    // Throws if error set
    void checkThrow() const noexcept(false) {
        if (hasCcode()) throw ccode();
        return;
    }

    // Throws error if set or "unset error" bug otherwise
    [[noreturn]] void rethrow() const noexcept(false) { throw ccode(); }

    // Explicitly declare an assignment to an error, we do this so we can
    // return a ref to our derived self and not the base variant.
    decltype(auto) operator=(Error &&error) {
        Parent::operator=(_mv(error));
        return *this;
    }

    // To string operator for logging
    template <typename Buffer>
    void __toString(Buffer &buf) const noexcept {
        if (hasCcode()) _tsb(buf, ccode());
    }

    // Error casting (no non const ref access)
    explicit operator Error() const noexcept(false) { return check(); }
};

}  // namespace ap
