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
namespace internal {
// So we can return refs, establish a null error singleton static api
static const Error &NoErrSingleton() noexcept {
    static Error noerr;
    return noerr;
}
}  // namespace internal

// ErrorOr is a variant that holds either an error, or a result. Its used
// to eliminate a lot of the boiler error handling logic that is typical
// of non exception friendly code bases. It allows you to use the visit
// paradigm to dispatch into a lambda on the success or error cases.
template <typename ResultT>
class ErrorOr : public std::variant<std::monostate, Error, ResultT> {
    // Restrict ResultT type from being Error or ErrorOr.
    static_assert(!traits::IsErrorV<ResultT>);
    static_assert(!traits::IsErrorOrV<ResultT>);

public:
    // Alias our base
    using Parent = std::variant<std::monostate, Error, ResultT>;

    // Use our bases constructors
    using Parent::Parent;

    // Use our bases assignment operators
    using Parent::operator=;

    // Publicly declare our primary result type
    using ResultType = ResultT;

    // So we can be used as if we were a unique ptr
    using element_type = ResultT;

    // Alias a trait for detecting objects that implement operator ->
    template <typename T>
    using HasDeref =
        std::negation<std::is_void<decltype(std::declval<T &>().operator->())>>;

    // Enable certain castings if type is numeric
    template <typename T>
    using IfNumeric = std::enable_if_t<std::is_arithmetic_v<T>>;

    // Disable certain castings if type is numeric
    template <typename T>
    using IfNotNumeric = std::enable_if_t<!std::is_arithmetic_v<T>>;

    // Alias a trait to conditionally disable if the type does not match our
    // result trait rules for Ptr types
    template <typename T>
    using IfPtr = std::enable_if_t<error::ResultTraits<T>::IsSmartPtr, T>;

    // Instantiate concrete attributes
    _const auto IsWeakPtr = traits::IsWeakPtrV<ResultType>;
    _const auto IsSharedPtr = traits::IsSharedPtrV<ResultType>;
    _const auto IsUniquePtr = traits::IsUniquePtrV<ResultType>;
    _const auto IsFactoryPtr = traits::IsPtrV<ResultType>;
    _const auto IsPtr = error::ResultTraits<ResultT>::IsSmartPtr;

    // Two primary states, hasCcode (failure), hasValue (success)
    bool hasCcode() const noexcept {
        return holds<Error>(*this) && ccode().isSet();
    }

    bool hasValue() const noexcept { return holds<ResultType>(*this); }

    // Ptr forwards for get, returns a ref to the ptr type
    template <typename T = ResultType, typename = IfPtr<T>>
    decltype(auto) get() const noexcept(false) {
        return value().get();
    }

    template <typename T = ResultType, typename = IfPtr<T>>
    decltype(auto) get() noexcept(false) {
        return value().get();
    }

    // Ptr forward for release, returns a released ptr
    template <typename T = ResultType, typename = IfPtr<T>>
    [[nodiscard]] decltype(auto) release() noexcept(false) {
        return value().release();
    }

    // Ccode accessor
    const Error &ccode() const & noexcept(false) {
        if (!holds<Error>(*this))
            throw APERR(Ec::Bug, "Access of ccode when no ccode present");
        return std::get<Error>(*this);
    }

    Error &ccode() & noexcept(false) {
        if (!holds<Error>(*this))
            throw APERR(Ec::Bug, "Access of ccode when no ccode present");
        return std::get<Error>(*this);
    }

    Error &&ccode() && noexcept(false) {
        if (!holds<Error>(*this))
            throw APERR(Ec::Bug, "Access of ccode when no ccode present");
        return _mv(std::get<Error>(_cast<ErrorOr &&>(*this)));
    }

    // Value accessor, throws if ccode held
    const ResultType &value() const & noexcept(false) {
        if (!hasValue()) throw ccode();
        return std::get<ResultType>(*this);
    }

    ResultType &value() & noexcept(false) {
        if (!hasValue()) throw ccode();
        return std::get<ResultType>(*this);
    }

    ResultType &&value() && noexcept(false) {
        if (!hasValue()) throw _mv(_cast<ErrorOr &&>(*this).ccode());
        return _mv(std::get<ResultType>(_cast<ErrorOr &&>(*this)));
    }

    // Deref, automatically forwards the -> along if the type supports it
    decltype(auto) operator->() const noexcept(false) {
        if constexpr (traits::IsDetected<HasDeref, ResultType>{})
            return value().operator->();
        else
            return &value();
    }

    decltype(auto) operator->() noexcept(false) {
        if constexpr (traits::IsDetected<HasDeref, ResultType>{})
            return value().operator->();
        else
            return &value();
    }

    // Operator *
    const ResultType &operator*() const & noexcept(false) { return value(); }

    ResultType &operator*() & noexcept(false) { return value(); }

    ResultType &&operator*() && noexcept(false) {
        return _mv(_cast<ErrorOr &&>(*this).value());
    }

    // No throw valueOr conditional return
    ResultType &valueOr(ResultType &def) & noexcept {
        return hasValue() ? value() : def;
    }

    ResultType &&valueOr(ResultType &&def) && noexcept {
        if (hasValue()) return _mv(_cast<ErrorOr &&>(*this).value());
        return _mv(def);
    }

    const ResultType &valueOr(const ResultType &def) const & noexcept {
        return hasValue() ? value() : def;
    }

    // Cast to an ErrorCode, explicit
    explicit operator ErrorCode() const noexcept {
        if (hasCcode()) return ccode().code();
        return {};
    }

    // Result type casting
    template <typename T = ResultType, typename = IfNotNumeric<T>>
    [[nodiscard]] operator ResultType &&() && noexcept(false) {
        return _mv(_cast<ErrorOr &&>(*this).value());
    }

    template <typename T = ResultType, typename = IfNotNumeric<T>>
    explicit operator ResultType &() & noexcept(false) {
        return value();
    }

    template <typename T = ResultType, typename = IfNotNumeric<T>>
    explicit operator const ResultType &() const & noexcept(false) {
        return value();
    }

    template <typename T = ResultType, typename = IfNotNumeric<T>>
    explicit operator ResultType() const noexcept(false) {
        return value();
    }

    // Operator bool equates to true if we hold a valid result
    explicit operator bool() const noexcept { return hasValue() == true; }

    // Check returns a ref to the held ccode, or a ref to the global singleton
    const Error &check() const & noexcept {
        if (hasCcode()) return ccode();
        return internal::NoErrSingleton();
    }

    // Error casting (no non const ref access)
    explicit operator const Error &() const & noexcept(false) {
        return check();
    }

    [[nodiscard]] explicit operator Error &&() && noexcept(false) {
        return _mv(_cast<ErrorOr &&>(*this).check());
    }

    // Throws if error set
    void checkThrow() noexcept(false) {
        if (hasCcode()) throw ccode();
        return;
    }

    // Throws error if set or "unset error" bug otherwise
    void rethrow() noexcept(false) { throw ccode(); }

    template <typename ResultTT,
              typename =
                  std::enable_if_t<std::is_convertible_v<ResultTT, ResultType>>>
    ErrorOr(const ErrorOr<ResultTT> &err) noexcept(false) {
        operator=(err);
    }

    template <typename ResultTT,
              typename =
                  std::enable_if_t<std::is_convertible_v<ResultTT, ResultType>>>
    decltype(auto) operator=(const ErrorOr<ResultTT> &err) noexcept(false) {
        if constexpr (std::is_arithmetic_v<ResultType> &&
                      std::is_arithmetic_v<ResultTT>) {
            if (err.hasValue())
                *this = _nc<ResultType>(err.value());
            else
                *this = err.ccode();
        } else {
            if (err.hasValue())
                *this = _cast<ResultType>(err.value());
            else
                *this = err.ccode();
        }
        return *this;
    }

    // Resets state to empty
    void reset() noexcept { *this = ErrorOr{}; }

    // To string operator for logging
    template <typename Buffer>
    Error __toString(Buffer &buf, const FormatOptions &opts) const noexcept {
        if (hasValue())
            return _tsbo(buf, opts, value());
        else if (hasCcode()) {
            if (opts.errorOrOk()) return _tsbo(buf, opts, ccode());
            return APERR(Ec::Bug, "Attempt to render ErrorOr with ccode",
                         ccode());
        } else if (!opts.errorOrOk())
            return APERR(Ec::Bug, "Attempt to render empty ErrorOr");
        return {};
    }
};

template <typename T>
inline ErrorCode make_error_code(const ErrorOr<T> &code) noexcept {
    if (code.hasCcode()) return code.ccode().code();
    return {};
}

}  // namespace ap
