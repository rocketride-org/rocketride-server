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

//
// To json conversion apis
//
#pragma once

namespace ap {
// Allow specifying R"(json...)"_json string
inline json::Value operator"" _json(const char *str,
                                    std::size_t count) noexcept {
    return json::parse(str);
}
}  // namespace ap

namespace ap::json {
// Uses the schema system to render a json type
template <typename Values, typename Paths>
inline ErrorOr<Value> renderSchema(const Pair<Values, Paths> &schema) noexcept {
    Error ccode;
    Value val;
    util::tuple::forEach(schema, [&](auto &value, auto &path) noexcept {
        auto res = toJsonEx(get<0>(value));
        if (res)
            val[get<0>(path)] = _mv(*res);
        else if (!ccode)
            ccode = res.ccode();
    });

    if (ccode) return ccode;

    return val;
}

// Central dispatch api for converting a type to json
template <typename T>
inline ErrorOr<Value> toJsonEx(const T &type) noexcept {
    // Obvious case
    if constexpr (traits::IsSameTypeV<T, Value>) {
        return type;
    }
    // Optional
    else if constexpr (traits::IsOptionalV<T>) {
        if (!type.has_value()) return Value();
        return toJsonEx(type.value());
    }
    // Schema
    else if constexpr (HasSchemaV<T>) {
        return renderSchema(type.__jsonSchema());
    }
    // Error (has template-based __toJson method due to being defined prior to
    // json::Value being included
    else if constexpr (traits::IsErrorV<T>) {
        Value result;
        type.__toJson(result);
        return result;
    }
    // Check for the non error form of the __toJson method
    else if constexpr (traits::IsDetectedExact<void, DetectToJsonMethod, T>{}) {
        Value result;
        if (auto res = _call(&T::__toJson, &type, result); res.check())
            return res.ccode();
        return result;
    }
    // Next check for the Error returning type
    else if constexpr (traits::IsDetectedExact<Error, DetectToJsonMethod,
                                               T>{}) {
        Value result;
        if (auto ccode = type.__toJson(result)) return ccode;
        return result;
    }
    // Global functions (adl lookup)
    else if constexpr (traits::IsDetectedExact<void, DetectToJsonFunction,
                                               T>{}) {
        Value result;
        if (auto res = _call([&] { __toJson(type, result); }); res.check())
            return res.ccode();
        return result;
    } else if constexpr (traits::IsDetectedExact<Error, DetectToJsonFunction,
                                                 T>{}) {
        Value result;
        if (auto ccode = __toJson(type, result)) return ccode;
        return result;
    }
    // Support basic type inference with container types, vector = json array
    else if constexpr (traits::IsSequenceContainerV<T> || traits::IsSetV<T> ||
                       traits::IsFlatSetV<T>) {
        Value result = ValueType::arrayValue;
        for (auto &elem : type) {
            auto res = toJsonEx(elem);
            if (!res) return _mv(res.ccode());
            result.append(_mv(*res));
        }
        return result;
    }
    // Support basic type inference with container types, vector = map
    else if constexpr (traits::IsMapV<T>) {
        Value result = ValueType::objectValue;

        for (auto &[key, val] : type) {
            auto keyRes = _tsc(key);
            auto valRes = _tjc(val);
            if (!keyRes) return _mv(keyRes.ccode());
            if (!valRes) return _mv(valRes.ccode());
            result[_mv(*keyRes)] = _mv(*valRes);
        }

        return result;
    } else if constexpr (traits::IsContainerV<T>) {
        static_assert(sizeof(T) == 0, "Unsupported container type");
    }
    // Final step is to attempt to convert the type to a string first
    else {
        static_assert(!traits::IsContainerV<T>, "Unsupported container type");
        Value result;
        auto res = _tsc(type);
        if (!res) return _mv(res.ccode());
        result = _mv(*res);
        return result;
    }
}

// Central dispatch api for converting a type to json
template <typename T>
inline Value toJson(const T &type) noexcept {
    auto res = toJsonEx(type);
    ASSERTD_MSG(res, "Failed to convert to json type:", util::typeName<T>(),
                res);
    return _mv(*res);
}

}  // namespace ap::json
