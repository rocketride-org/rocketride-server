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

namespace {
// Custom overflow handler for boost::numeric_cast so we can intercept errors
struct NumericCastOverflowHandler {
    void operator()(boost::numeric::range_check_result r) noexcept {
        switch (r) {
            case boost::numeric::cInRange:
                // Expected
                break;

            case boost::numeric::cNegOverflow:
                dev::fatality(_location,
                              "Boost numeric cast negative overflow");
                break;

            case boost::numeric::cPosOverflow:
                dev::fatality(_location,
                              "Boost numeric cast positive overflow");
                break;

            default:
                dev::fatality(_location, "Unexpected Boost numeric cast error",
                              r);
                break;
        }
    }
};
}  // namespace

// Safely casts numbers between varying types, if an overflow or
// underflow occurs, an abort will be raised
// @notes
// Using boost numeric cast because this is a non trivial check
// especially when floating types get involved
template <typename To, typename From, typename OverflowHandler>
inline To numericCast(From value) noexcept {
    if constexpr (traits::IsSameTypeV<From, Size>)
        return numericCast<To>(static_cast<typename Size::ValueType>(value));
    else if constexpr (traits::IsSameTypeV<To, Size>)
        return numericCast<Size::ValueType>(value);
    else if constexpr (traits::IsSameTypeV<From, Error>)
        return value.template code<To>();
    else {
        using namespace boost::numeric;

        // Invoke the Boost converter directly instead of calling
        // boost::numeric_cast so we can use our overflow handler
        typedef conversion_traits<To, From> conv_traits;
        typedef numeric_cast_traits<To, From> cast_traits;
        typedef converter<To, From, conv_traits, OverflowHandler,
                          typename cast_traits::rounding_policy,
                          raw_converter<conv_traits>,
                          typename cast_traits::range_checking_policy>
            thisConverter;
        return thisConverter::convert(value);
    }
}

template <typename To, typename From>
inline To numericCast(From value) noexcept {
    return numericCast<To, From, NumericCastOverflowHandler>(value);
}

}  // namespace ap
