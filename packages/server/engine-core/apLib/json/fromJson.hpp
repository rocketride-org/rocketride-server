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

//
// From json conversion apis
//
#pragma once

namespace ap::json {

namespace {

// Parses a schema structure
template <typename T>
inline Error parseSchema(T &result, const Value &val) noexcept {
    Error ccode;

    util::tuple::forEach(
        result.__jsonSchema(), [&](const auto &value, auto &path) noexcept {
            auto &typeVal = get<0>(value);
            ccode |= val.lookupAssign(
                get<0>(path),
                _constCast<traits::StripT<decltype(typeVal)> &>(typeVal));
        });

    return ccode;
}

}  // namespace

template <typename T, typename... Args>
inline ErrorOr<T> fromJsonEx(const Value &j, Args &&...args) noexcept {
    // Verify the type is movable
    static_assert(std::is_move_constructible_v<T>,
                  "Json types must be move constructible");

    // Obvious case
    if constexpr (traits::IsSameTypeV<T, Value>) {
        return j;
    }
    // Optional
    else if constexpr (traits::IsOptionalV<T>) {
        if (!j) return NullOpt;
        return fromJsonEx<traits::ValueT<T>>(j, std::forward<Args>(args)...);
    }
    // Check for the throwing form of the __fromJson method
    else if constexpr (traits::IsDetectedExact<T, DetectThrowingFromJsonMethod,
                                               T, Args...>{}) {
        return _call(
            [&] { return T::__fromJson(j, std::forward<Args>(args)...); });
    } else {
        // Every other form requires T be default constructible
        static_assert(std::is_default_constructible_v<T>,
                      "Json types must be default constructible");

        // Check for a schema
        if constexpr (HasSchemaV<T>) {
            T result;
            if (auto ccode = parseSchema(result, j)) return ccode;

            // If parsed successfully from the schema, check for validation
            // callbacks
            if constexpr (HasJsonValidateV<T>) {
                if (auto ccode = result.__jsonValidate()) return ccode;
            } else if constexpr (HasValidV<T>) {
                if (!result.valid()) return APERR(Ec::InvalidJson);
            }

            return result;
        }
        // Check for the non error form of the __fromJson method
        else if constexpr (traits::IsDetectedExact<void, DetectFromJsonMethod,
                                                   T, Args...>{}) {
            T result;
            T::__fromJson(result, j, std::forward<Args>(args)...);
            return result;
        }
        // Next check for the Error returning type
        else if constexpr (traits::IsDetectedExact<Error, DetectFromJsonMethod,
                                                   T, Args...>{}) {
            T result;
            if (auto ccode = _callChk([&] {
                    return T::__fromJson(result, j,
                                         std::forward<Args>(args)...);
                }))
                return ccode;
            return result;
        }
        // Global functions (adl lookup)
        else if constexpr (traits::IsDetectedExact<void, DetectFromJsonFunction,
                                                   T>{}) {
            T result;
            if (auto res = _call([&] { __fromJson(result, j); }); res.check())
                return res.ccode();
            return result;
        } else if constexpr (traits::IsDetectedExact<
                                 Error, DetectFromJsonFunction, T>{}) {
            T result;
            if (auto ccode = __fromJson(result, j)) return ccode;
            return result;
        }
        // Support basic type inference with container types, vector = json
        // array
        else if constexpr (traits::IsSequenceContainerV<T>) {
            T result;

            if (j.type() != ValueType::arrayValue)
                return Error{Ec::InvalidJson, _location, "Expected array",
                             util::typeName<T>(), j};

            for (decltype(j.size()) i = 0; i < j.size(); i++) {
                auto &val = j[i];
                auto res = fromJsonEx<traits::ValueT<T>>(
                    val, std::forward<Args>(args)...);
                if (!res) return res.ccode();
                result.emplace_back(_mv(*res));
            }
            return result;
        }
        // set = json array, will verify key collisions
        else if constexpr (traits::IsSetV<T> || traits::IsFlatSetV<T>) {
            T result;

            if (j.type() != ValueType::arrayValue)
                return Error{Ec::InvalidJson, _location, "Expected array",
                             util::typeName<T>(), j.type()};

            for (decltype(j.size()) i = 0; i < j.size(); i++) {
                auto &val = j[i];
                auto res = fromJsonEx<traits::ValueT<T>>(
                    val, std::forward<Args>(args)...);
                if (!res) return res.ccode();
                if (auto iter = result.find(*res); iter != result.end())
                    return APERR(Ec::InvalidJson,
                                 "Duplicate in key for set conversion:", *res,
                                 j);
                result.insert(_mv(*res));
            }
            return result;
        }
        // Support basic type inference with container types, vector = map
        else if constexpr (traits::IsMapV<T> || traits::IsFlatMapV<T>) {
            T result;

            if (j.type() != ValueType::objectValue)
                return Error{Ec::InvalidJson, _location, "Expected object",
                             util::typeName<T>()};

            for (auto &key : j.getMemberNames()) {
                if (auto ccode = j.lookupAssign(
                        key, result[_tr<typename T::key_type>(key)],
                        std::forward<Args>(args)...))
                    return ccode;
            }

            return result;
        } else if constexpr (traits::IsContainerV<T>) {
            static_assert(sizeof(T) == 0, "Unsupported container type");
        }
        // Final step is to attempt to convert the type to a string first
        else if (j.isString() || j.isNumeric()) {
            return _fsc<T>(j.asString());
        } else {
            return Error{Ec::InvalidJson, _location,
                         "No way to convert type from json to",
                         util::typeName<T>(), j};
        }
    }
}

template <typename T, typename... Args>
inline ErrorOr<T> fromJsonEx(const Value *j, Args &&...args) noexcept {
    return fromJsonEx<T>(*j, std::forward<Args>(args)...);
}

// Central dispatch api for converting a type from json
template <typename T, typename... Args>
inline T fromJson(const Value &j, Args &&...args) noexcept {
    auto res = fromJsonEx<T>(j, std::forward<Args>(args)...);
    ASSERTD_MSG(res, "Failed to convert from json type\n", util::typeName<T>(),
                "\n", res, "\n", j);
    return _mv(*res);
}

template <typename T, typename... Args>
inline T fromJson(const Value *j, Args &&...args) noexcept {
    return fromJson<T>(*j, std::forward<Args>(args)...);
}

template <typename T, typename... Args>
inline Error fromJsonAssign(const Value &j, T &result,
                            Args &&...args) noexcept {
    auto res = fromJsonEx<T>(j, std::forward<Args>(args)...);
    if (!res) return res.ccode();
    result = _mv(*res);
    return {};
}

}  // namespace ap::json
