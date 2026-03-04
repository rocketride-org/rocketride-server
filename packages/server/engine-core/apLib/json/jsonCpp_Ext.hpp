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

namespace ap::json {

// Construct from a text view
template <typename TraitsT>
inline Value::Value(string::StrView<char, TraitsT> value) noexcept {
    initBasic(stringValue, true);
    value_.string_ = duplicateAndPrefixStringValue(value.data(),
                                                   _nc<unsigned>(value.size()));
}

// Lookup a value by its path, and convert it to the requested
// type. If not found, default value will be used. All
// conversions use the string pack api, allowing any type
// to be marshalled into and from json. Checked version
// returns an ErrorOr if the conversion failed.
template <typename T, typename... Args>
inline ErrorOr<T> Value::lookupInternal(TextView path,
                                        Args &&...args) const noexcept {
    // Can't return TextViews (yet)
    static_assert(!traits::IsSameTypeV<TextView, T>,
                  "Illegal type request of TextView for lookup");
    static_assert(!traits::IsSameTypeV<T, Value *>,
                  "Cannot lookup Value * with lookup, use getKey");

    if constexpr (traits::IsSameTypeV<ValueType, T>) {
        auto val = getKey(path);
        if (!val || val->isNull()) return ValueType::nullValue;
        return val->type();
    } else if constexpr (traits::IsSameTypeV<TextVector, T>) {
        return textVector(path);
    } else if constexpr (traits::IsSameTypeV<Value, T>) {
        if (auto val = getKey(path)) return *val;
        return Error{Ec::NotFound, _location, "Json value not found"};
    } else {
        // Lookup the key
        auto val = getKey(path);
        if (!val) return Error{Ec::NotFound, _location, "Json value not found"};

        // Optimizations for numeric types
        if constexpr (traits::IsSameTypeV<bool, T>) {
            if (val->isNull()) return false;
            if (val->isBool())
                return val->asBool();
            else if (val->isNumeric())
                return static_cast<bool>(val->asInt());
        } else if constexpr (std::is_floating_point_v<T>) {
            if (val->isNull()) return _nc<T>(0);
            if (val->isNumeric()) return _nc<T>(val->asDouble());
        } else if constexpr (std::is_signed_v<T>) {
            if (val->isNull()) return _nc<T>(0);
            if (val->isNumeric()) return _nc<T>(val->asLargestInt());
        } else if constexpr (std::is_unsigned_v<T>) {
            if (val->isNull()) return _nc<T>(0);
            if (val->isNumeric()) return _nc<T>(val->asLargestUInt());
        }

        // Some other custom type (including string), forward
        // to overrideable json hooks, which will itself
        // defer to string
        auto res = _fjc<T>(*val, std::forward<Args>(args)...);
        if (res.check()) return res;

        return _mv(res.value());
    }
}

}  // namespace ap::json
