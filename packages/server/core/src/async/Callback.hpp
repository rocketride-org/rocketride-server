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

namespace ap {

// The callback class wraps a callable with one or more arguments and
// defers the execution of the callback until the invoke api is called.
// Most importantly this class is not templated in anyway allowing for
// use in non templated cases.
class Callback {
public:
    Callback() = default;

    // The invoker is our means of encapsulating a type specific callback
    // with a non type specific Callback object. The invoker can be returned
    // to the caller if the caller needs to fetch the result post invocation.
    struct InvokerBase {
        virtual Error invoke(Location location) noexcept = 0;
        virtual void release() noexcept = 0;
        std::any m_result;
    };

    using InvokerPtr = std::shared_ptr<InvokerBase>;

    template <typename Func, typename Result, typename... Args>
    struct Invoker;

    template <typename Func, typename Result, typename... Args>
    struct Invoker_CopiedArgs;

    // Constructs a callback from a callback and a series of args. The args
    // in this constructor are perfect forwarded.
    template <typename Func, typename... Args>
    explicit Callback(Func &&func, Args &&...args) noexcept
        : m_invoker(staticPtrCast<InvokerBase>(allocateInvoker(
              std::forward<Func>(func), std::forward<Args>(args)...))) {}

    // Makes a callback from a callback and a series of args.
    // The args in this constructor are copied.
    template <typename Func, typename... Args>
    static Callback makeCopy(Func &&func, Args &&...args) noexcept {
        return Callback(staticPtrCast<InvokerBase>(allocateInvoker_CopyArgs(
            std::forward<Func>(func), std::forward<Args>(args)...)));
    }

    // Constructs from a pre-allocated invoker object.
    explicit Callback(std::shared_ptr<InvokerBase> invoker) noexcept
        : m_invoker(_mv(invoker)) {}

    // Allocates a callback invoker object, arguments are copied.
    template <typename Func, typename... Args>
    static std::shared_ptr<
        Invoker_CopiedArgs<Func, std::invoke_result_t<Func, Args...>, Args...>>
    allocateInvoker_CopyArgs(Func func, Args... args) noexcept {
        return makeShared<Invoker_CopiedArgs<
            Func, std::invoke_result_t<Func, Args...>, Args...>>(_mv(func),
                                                                 _mv(args)...);
    }

    // Allocates a callback invoker object, arguments are perfect forwarded.
    template <typename Func, typename... Args>
    static std::shared_ptr<
        Invoker<Func, std::invoke_result_t<Func, Args...>, Args...>>
    allocateInvoker(Func func, Args &&...args) noexcept {
        return makeShared<
            Invoker<Func, std::invoke_result_t<Func, Args...>, Args...>>(
            std::forward<Func>(func), std::forward<Args>(args)...);
    }

    // Move/copies allowed due to the internal shared_ptr
    Callback(Callback &&cb) noexcept = default;
    Callback &operator=(Callback &&cb) noexcept = default;

    Callback &operator=(const Callback &cb) = default;
    Callback(const Callback &cb) = default;

    auto invoke(Location location) const noexcept {
        ASSERT(m_invoker);
        return m_invoker->invoke(location);
    }

    explicit operator bool() const noexcept {
        return static_cast<bool>(m_invoker);
    }

    void reset() noexcept { m_invoker.reset(); }

    void release() noexcept { reset(); }

    auto invoker() const noexcept { return m_invoker; }

    template <typename ResultT>
    ErrorOr<ResultT> result() const noexcept {
        return _call(
            [&] { return _mv(std::any_cast<ResultT>(m_invoker->m_result)); });
    }

protected:
    // We keep a base ptr to our invoker so that the Callback object
    // itself does not need to be templated
    InvokerPtr m_invoker;
};

// Declare the invoker template specializations, primarily based around
// arg and return types.

// This template struct gets selected when the result of the callback is
// void, it provides no return value capture.
template <typename Func, typename... Args>
struct Callback::Invoker<
    Func,
    std::enable_if_t<std::is_void_v<std::invoke_result_t<Func, Args...>>,
                     std::invoke_result_t<Func, Args...>>,
    Args...> : public InvokerBase {
    Invoker(Func func, Args &&...args) noexcept
        : m_args(std::forward_as_tuple(std::forward<Args>(args)...)),
          m_func(std::forward<Func &&>(func)) {}

    ~Invoker() noexcept {}

    Error invoke(Location location) noexcept override {
        return _callChk([&] { invokeInternal(m_args); });
    }

    void release() noexcept override { m_func.~Func(); }

    template <typename Tuple>
    typename std::enable_if<0 != std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        return std::apply(m_func, m_args);
    }

    template <typename Tuple>
    typename std::enable_if<0 == std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        m_func();
    }

    Func m_func;
    std::tuple<Args &&...> m_args;
};

// This template struct gets selected when the result of the callback is
// non-void, it captures the result.
template <typename Func, typename... Args>
struct Callback::Invoker<
    Func,
    std::enable_if_t<
        !traits::IsErrorV<std::invoke_result_t<Func, Args...>> &&
            !traits::IsErrorOrV<std::invoke_result_t<Func, Args...>> &&
            !std::is_void_v<std::invoke_result_t<Func, Args...>>,
        std::invoke_result_t<Func, Args...>>,
    Args...> : public InvokerBase {
    Invoker(Func func, Args &&...args) noexcept
        : m_args(std::forward_as_tuple(std::forward<Args>(args)...)),
          m_func(std::forward<Func>(func)) {}

    ~Invoker() noexcept {}

    Error invoke(Location location) noexcept override {
        return _callChk([&] { invokeInternal(m_args); });
    }

    void release() noexcept override { m_func.~Func(); }

    template <typename Tuple>
    typename std::enable_if<0 != std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        m_result = std::apply(m_func, m_args);
    }

    template <typename Tuple>
    typename std::enable_if<0 == std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        m_result = m_func();
    }

    Func m_func;
    std::tuple<Args &&...> m_args;
};

// Non copies args error version
template <typename Func, typename... Args>
struct Callback::Invoker<
    Func,
    std::enable_if_t<traits::IsErrorV<std::invoke_result_t<Func, Args...>>,
                     std::invoke_result_t<Func, Args...>>,
    Args...> : public InvokerBase {
    Invoker(Func func, Args &&...args) noexcept
        : m_args(std::forward_as_tuple(std::forward<Args>(args)...)),
          m_func(std::forward<Func>(func)) {}

    ~Invoker() noexcept {}

    Error invoke(Location location) noexcept override {
        return _callChk([&] {
            invokeInternal(m_args);
            return _mv(std::any_cast<Error>(m_result));
        });
    }

    void release() noexcept override { m_func.~Func(); }

    template <typename Tuple>
    typename std::enable_if<0 != std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        m_result = std::apply(m_func, m_args);
    }

    // Intermittently getting an "unreachable code" warning there that doesn't
    // make any sense; disable for now
    // @@ TODO Fix
#pragma warning(push)
#pragma warning(disable : 4702)
    template <typename Tuple>
    typename std::enable_if<0 == std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        m_result = m_func();
    }
#pragma warning(pop)

    Func m_func;
    std::tuple<Args &&...> m_args;
};

// This template struct gets selected when the result of the callback is
// void, it provides no return value capture.
template <typename Func, typename... Args>
struct Callback::Invoker_CopiedArgs<
    Func,
    std::enable_if_t<std::is_void_v<std::invoke_result_t<Func, Args...>>,
                     std::invoke_result_t<Func, Args...>>,
    Args...> : public InvokerBase {
    Invoker_CopiedArgs(Func func, Args... args) noexcept
        : m_args(std::make_tuple(args...)), m_func(std::forward<Func>(func)) {}

    ~Invoker_CopiedArgs() noexcept {}

    Error invoke(Location location) noexcept override {
        return _callChk([&] { invokeInternal(m_args); });
    }

    void release() noexcept override { m_func.~Func(); }

    template <typename Tuple>
    typename std::enable_if<0 != std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        return std::apply(m_func, m_args);
    }

    template <typename Tuple>
    typename std::enable_if<0 == std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        m_func();
    }

    Func m_func;
    std::tuple<Args...> m_args;
};

// This template struct gets selected when the result of the callback is
// non-void, it captures the result.
template <typename Func, typename... Args>
struct Callback::Invoker_CopiedArgs<
    Func,
    std::enable_if_t<
        !traits::IsErrorV<std::invoke_result_t<Func, Args...>> &&
            !traits::IsErrorOrV<std::invoke_result_t<Func, Args...>> &&
            !std::is_void_v<std::invoke_result_t<Func, Args...>>,
        std::invoke_result_t<Func, Args...>>,
    Args...> : public InvokerBase {
    Invoker_CopiedArgs(Func func, Args... args) noexcept
        : m_args(std::make_tuple(args...)), m_func(std::forward<Func>(func)) {}

    ~Invoker_CopiedArgs() noexcept {}

    Error invoke(Location location) noexcept override {
        return _callChk([&] { invokeInternal(m_args); });
    }

    void release() noexcept override { m_func.~Func(); }

    template <typename Tuple>
    typename std::enable_if<0 != std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        m_result = std::apply(m_func, m_args);
    }

    template <typename Tuple>
    typename std::enable_if<0 == std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        m_result = m_func();
    }

    Func m_func;
    std::tuple<Args...> m_args;
};

// This template struct gets selected when the result of the callback is
// Error
template <typename Func, typename... Args>
struct Callback::Invoker_CopiedArgs<
    Func,
    std::enable_if_t<traits::IsErrorV<std::invoke_result_t<Func, Args...>>,
                     std::invoke_result_t<Func, Args...>>,
    Args...> : public InvokerBase {
    Invoker_CopiedArgs(Func func, Args... args) noexcept
        : m_args(std::make_tuple(args...)), m_func(std::forward<Func>(func)) {}

    ~Invoker_CopiedArgs() noexcept {}

    Error invoke(Location location) noexcept override {
        return _callChk([&] {
            invokeInternal(m_args);
            return _mv(std::any_cast<Error>(m_result));
        });
    }

    void release() noexcept override { m_func.~Func(); }

    template <typename Tuple>
    typename std::enable_if<0 != std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        m_result = std::apply(m_func, m_args);
    }

    // See above
#pragma warning(push)
#pragma warning(disable : 4702)
    template <typename Tuple>
    typename std::enable_if<0 == std::tuple_size<Tuple>::value, void>::type
    invokeInternal(const Tuple &tp) {
        m_result = m_func();
    }
#pragma warning(pop)

    Func m_func;
    std::tuple<Args...> m_args;
};

// Note there is no definition for a return type of ErrorOr, as it is not
// allowed

}  // namespace ap
