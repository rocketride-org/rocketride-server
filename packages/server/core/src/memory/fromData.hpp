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

namespace ap::memory {

namespace {

template <typename T>
inline Error validate(const T &result) noexcept {
    Error ccode;

    if constexpr (traits::IsDetectedExact<Error, traits::DetectValidateMethod,
                                          T>{})
        ccode = result.__validate();
    else if constexpr (traits::IsDetectedExact<
                           void, traits::DetectValidateMethod, T>{})
        ccode = _callChk([&] { result.__validate(); });

    return ccode;
}

template <typename T, typename Input, typename Value = traits::ValueT<T>>
inline void unpackContainerData(const Input &in, T &result) noexcept(false) {
    // Figure out how many elements we have
    auto count = _fdb<PackHdr>(in)->size;

    // May have been marshaled as an empty one if so nothing to do
    if (!count) {
        result.clear();
        return;
    }

    for (auto i = 0; i < count; i++) {
        if constexpr (traits::IsVectorV<T> || traits::IsListV<T>)
            validate(result.emplace_back(*_fdb<Value>(in)));
        else
            validate(result.emplace(*_fdb<Value>(in)));
    }

    LOG(Data, "{} Unpacked {,c} elements for non pod container", in, count);
}

template <typename T, typename Input, typename Value = traits::ValueT<T>>
inline void unpackPodVector(const Input &in, T &result) noexcept(false) {
    // Read the data in all at once and memcpy it directly into the vector,
    // this is the most optimized means of marshaling a vector
    auto hdr = *_fdb<PackHdr>(in);

    // May have been marshaled as an empty one if so nothing to do
    if (!hdr.size) {
        result.clear();
        return;
    }

    auto size = hdr.size;

    if (size % sizeof(Value))
        APERR_THROW(Ec::Bug, "Invalid alignment", size, sizeof(Value));

    result.resize(size / sizeof(Value));

    // Read it in
    in.read({_reCast<uint8_t *>(&result.front()), size});

    LOG(Data, "{} Unpacked {} pod vector elements", in, result.size());
}

template <typename T, typename Input, typename Value = traits::ValueT<T>>
inline void unpackContainer(const Input &in, T &result) noexcept(false) {
    static_assert(!traits::IsArrayV<T>, "Arrays are not supported");

    // Limit the scope for now
    if constexpr (traits::IsDetectedExact<Error, traits::DetectDataUnpackMethod,
                                          Value, Input>{} ||
                  traits::IsDetectedExact<void, traits::DetectDataUnpackMethod,
                                          T, Input>{})
        static_assert(sizeof(T) == 0,
                      "Un-packing of custom non pod items is not supported");
    else if constexpr (traits::IsFlatSetV<T>)
        unpackContainer(in, result.container);
    else if constexpr (traits::IsFlatMapV<T>)
        unpackContainer(in, result.container);
    else if constexpr (traits::IsVectorV<T>) {
        if constexpr (traits::IsPodV<Value>)
            unpackPodVector(in, result);
        else if constexpr (traits::IsPairV<Value>) {
            if constexpr (traits::IsPodV<typename Value::first_type> &&
                          traits::IsPodV<typename Value::second_type>)
                unpackPodVector(in, result);
            else
                unpackContainerData(in, result);
        } else
            unpackContainerData(in, result);
    } else if constexpr (traits::IsContainerV<T>)
        unpackContainerData(in, result);
    else
        static_assert(sizeof(T) == 0, "No binary pack method implemented");
}

template <typename T, typename Input, typename... Args>
inline auto unpack(const Input &in, T &result, Args &&...args) noexcept
    -> adapter::concepts::IfInput<Input, Error> {
    // Member versions
    if constexpr (traits::IsDetectedExact<Error, traits::DetectDataUnpackMethod,
                                          T, Input, Args...>{})
        return _callChk([&] {
            return T::__fromData(result, in, std::forward<Args>(args)...);
        });
    else if constexpr (traits::IsDetectedExact<void,
                                               traits::DetectDataUnpackMethod,
                                               T, Input, Args...>{})
        return _callChk(
            [&] { T::__fromData(result, in, std::forward<Args>(args)...); });

    // Adl lookup versions
    else if constexpr (traits::IsDetectedExact<Error,
                                               traits::DetectDataUnpackFunction,
                                               T, Input, Args...>{})
        return _callChk([&] {
            return __fromData(result, in, std::forward<Args>(args)...);
        });
    else if constexpr (traits::IsDetectedExact<void,
                                               traits::DetectDataUnpackFunction,
                                               T, Input, Args...>{})
        return _callChk(
            [&] { __fromData(result, in, std::forward<Args>(args)...); });

    else if constexpr (traits::IsPairV<T>) {
        if constexpr (traits::IsPodV<typename T::first_type> &&
                      traits::IsPodV<typename T::second_type>)
            return _callChk(
                [&] { return in.read({(uint8_t *)(&result), sizeof(T)}); });
        else
            return _callChk([&] {
                unpack(in, result.first);
                unpack(in, result.second);
            });
    } else if constexpr (traits::IsPodV<T>)
        return _callChk(
            [&] { return in.read({(uint8_t *)(&result), sizeof(T)}); });
    else if constexpr (traits::IsContainerV<T>)
        return _callChk([&] { unpackContainer(in, result); });
    else
        static_assert(sizeof(T) == 0, "No binary pack method implemented");
}

template <typename T, typename Input, typename... Args>
inline auto unpack(const Input &_in, T &result, Args &&...args) noexcept
    -> adapter::concepts::IfNotInput<Input, Error> {
    auto in = adapter::makeInput(_in);
    return unpack<T>(in, result, std::forward<Args>(args)...);
}

}  // namespace

template <typename T, typename Input, typename... Args>
inline ErrorOr<T> fromData(const Input &in, Args &&...args) noexcept {
    T result = {};

    if (auto ccode = unpack(in, result, std::forward<Args>(args)...))
        return ccode;

    // Allow the type to self validate if it exposes a method to do so
    if (auto ccode = validate(result)) return ccode;

    return result;
}

template <typename T, typename Input, typename... Args>
inline Error fromDataAssign(const Input &in, T &result,
                            Args &&...args) noexcept {
    return unpack(in, result, std::forward<Args>(args)...);
}

}  // namespace ap::memory
