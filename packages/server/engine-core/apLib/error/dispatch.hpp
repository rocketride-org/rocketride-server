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
// These templates create a dispatchable lambda for std::visit usage below
template <class... Ts>
struct overloaded : Ts... {
    using Ts::operator()...;
};
template <class... Ts>
overloaded(Ts...) -> overloaded<Ts...>;

// This handy template takes away a little boiler code when handling
// results from apis returning variant erros with results.
// @notes
// To use you first need a function that returns a variant, with
// an Error as its first alternative, then some ResultType as its
// 'success' alternative. You then can use dispatch to eliminate
// many error code checking and return handling like so:
//
// 	ErrorOr<MyREsult> MyFunction...
//
// 	return dispatch([&](MyResult &&result) {
// 		// Yaay I got a successful result but I'm too lazy to
// 		// return ccode myself, yaay
// 	}, MyFunction());
//
// You may also return your Error if you want to, as we handle both cases
// like so:
//
// 	ErrorOr<MyREsult> MyFunction...
//
// 	return dispatch([&](MyResult &&result)->Error {
// 		// Yaay I got a successful result but I like to be explicit
// 		// and I'm not too lazy!
// 		return 0;
// 	}, MyFunction());
//
// If however you *want* to handle the error yourself, you may also
// call it like so:
//
// 	ErrorOr<MyREsult> MyFunction...
//
// 	return dispatch(
// 		[&](Error &&ccode)->Error { // Error handler c},
// 		[&](MyResult &&result)->Error { // Success handler }
// 	, MyFunction());
//
template <typename ErrorHandler, typename SuccessHandler, typename ResultType>
inline auto dispatch(ErrorHandler &&errorHandler,
                     SuccessHandler &&successHandler,
                     std::variant<std::monostate, Error, ResultType> &&variant,
                     Location location = {}) noexcept {
    // Allow the error handler to optionally return an error
    auto errorHandlerWrapper = [&](Error &&ccode) -> Error {
        if constexpr (std::is_same_v<std::invoke_result_t<ErrorHandler, Error>,
                                     Error>)
            return errorHandler(std::move(ccode));
        else {
            // Technically we can only know what it returns if we check
            // the type ahead of time but, allow it worst case the resulting
            // value is ignored
            auto _ccode = ccode;
            errorHandler(std::move(_ccode));
            return ccode;
        }
    };

    // The goal here is to allow the caller freedom of syntax, if they don't
    // want to return anything from their handler they don't have to, we'll
    // return an empty Error for them, if they do, we'll just forward their
    // error through, so we have two compile time gates here depending on the
    // result type of the lambda
    try {
        if constexpr (std::is_void_v<
                          std::invoke_result_t<SuccessHandler, ResultType>>) {
            return std::visit(overloaded{errorHandlerWrapper,
                                         [&](std::monostate) -> Error {
                                             return APERR(Ec::Bug,
                                                          "No response set");
                                         },
                                         [&](ResultType &&result) -> Error {
                                             successHandler(std::move(result));
                                             return {};
                                         }},
                              std::move(variant));
        } else if constexpr (std::is_same_v<std::invoke_result_t<SuccessHandler,
                                                                 ResultType>,
                                            Error>) {
            return std::visit(
                overloaded{errorHandlerWrapper,
                           [&](std::monostate) -> Error {
                               return APERR(Ec::Bug, "No response set");
                           },
                           [&](ResultType &&result) -> Error {
                               return successHandler(std::move(result));
                           }},
                std::move(variant));
        } else {
            static_assert(sizeof(SuccessHandler) == 0,
                          "SucessHandler must either return void, or Error");
        }
    } catch (const std::exception &e) {
        return Error{Ec::Exception, _locationOr(location), e.what()};
    }
}

template <typename SuccessHandler, typename ResultType>
inline auto dispatch(SuccessHandler &&handler, ErrorOr<ResultType> &&variant,
                     Location location = {}) noexcept {
    return dispatch([](auto &&ccode) {}, std::forward<SuccessHandler>(handler),
                    std::move(variant), location);
}

template <typename ResultType>
inline auto dispatch(ErrorOr<ResultType> &&variant,
                     Location location = {}) noexcept {
    return dispatch([](auto &&ccode) {}, [](auto &&result) {},
                    std::move(variant), location);
}

}  // namespace ap
