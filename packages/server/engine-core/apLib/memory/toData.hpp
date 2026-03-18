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

template <typename T, typename Output, typename Value = traits::ValueT<T>>
inline void packContainerData(Output &out, const T &entry) noexcept(false) {
    // Since we're not writing this as a raw pod, just store the number of
    // entries rather then the byte size
    auto count = entry.size();
    *_tdb(out, PackHdr{count});

    // Now write each type out
    for (auto &item : entry) *_tdb(out, item);

    LOG(Data, "{} Packed {,c} elements for non pod container", out,
        entry.size());
}

template <typename T, typename Output, typename Value = traits::ValueT<T>>
inline void packPodVector(Output &out, const T &entry) noexcept(false) {
    // This is a pod type so its size is directly known
    auto size = entry.size() * sizeof(Value);

    // Write out the size first
    *_tdb(out, PackHdr{size});

    // And now the data in the vector (if its not empty anyway)
    if (!entry.empty())
        out.write({_reCast<const uint8_t *>(&entry.front()), size});

    LOG(Data, "{} Packed {} pod vector elements totaling {,s}", out,
        entry.size(), size);
}

template <typename T, typename Output, typename Value = traits::ValueT<T>>
inline void packContainer(Output &out, const T &entry) noexcept(false) {
    static_assert(!traits::IsArrayV<T>, "Arrays are not supported");

    // Limit the scope for now
    if constexpr (traits::IsDetectedExact<Error, traits::DetectDataPackMethod,
                                          Value, Output>{} ||
                  traits::IsDetectedExact<void, traits::DetectDataPackMethod, T,
                                          Output>{})
        static_assert(sizeof(T) == 0,
                      "Packing of custom non pod items is not supported");
    else if constexpr (traits::IsFlatSetV<T>)
        packContainer(out, entry.container);
    else if constexpr (traits::IsFlatMapV<T>)
        packContainer(out, entry.container);
    else if constexpr (traits::IsVectorV<T>) {
        if constexpr (traits::IsPodV<Value>)
            packPodVector(out, entry);
        else if constexpr (traits::IsPairV<Value>) {
            if constexpr (traits::IsPodV<typename Value::first_type> &&
                          traits::IsPodV<typename Value::second_type>)
                packPodVector(out, entry);
            else
                packContainerData(out, entry);
        } else
            packContainerData(out, entry);
    } else if constexpr (traits::IsContainerV<T>)
        packContainerData(out, entry);
    else
        static_assert(sizeof(T) == 0, "No binary pack method implemented");
}

template <typename Output, typename T>
inline auto pack(Output &out, const T &entry) noexcept
    -> adapter::concepts::IfOutput<Output, Error> {
    // Member versions
    if constexpr (traits::IsDetectedExact<Error, traits::DetectDataPackMethod,
                                          T, Output>{})
        return _callChk([&] { return entry.__toData(out); });
    else if constexpr (traits::IsDetectedExact<
                           void, traits::DetectDataPackMethod, T, Output>{})
        return _callChk([&] { entry.__toData(out); });

    // Adl lookup versions
    else if constexpr (traits::IsDetectedExact<
                           Error, traits::DetectDataPackFunction, T, Output>{})
        return _callChk([&] { return __toData(entry, out); });
    else if constexpr (traits::IsDetectedExact<
                           void, traits::DetectDataPackFunction, T, Output>{})
        return _callChk([&] { __toData(entry, out); });

    else if constexpr (traits::IsPairV<T>) {
        if constexpr (traits::IsPodV<typename T::first_type> &&
                      traits::IsPodV<typename T::second_type>)
            return _callChk([&] {
                return out.write({(const uint8_t *)&entry, sizeof(T)});
            });
        else
            return _callChk([&] {
                pack(out, entry.first);
                pack(out, entry.second);
            });
    } else if constexpr (traits::IsPodV<T>)
        return _callChk([&] { return out.write(viewCast(entry)); });
    else if constexpr (traits::IsContainerV<T>)
        return _callChk([&] { packContainer(out, entry); });
    else if constexpr (traits::IsStrV<T> || traits::IsStrViewV<T>)
        return _callChk([&] { packPodVector(out, entry); });
    else
        static_assert(sizeof(T) == 0,
                      "Unable to select method to binary pack type");
}

template <typename Output, typename T>
inline auto pack(Output &_out, const T &entry) noexcept
    -> adapter::concepts::IfNotOutput<Output, Error> {
    auto out = adapter::makeOutput(_out);
    return pack(out, entry);
}

}  // namespace

template <typename Output, typename... Args>
inline Error toDataEx(Output &out, const Args &...args) noexcept {
    Error ccode;
    ([&](auto &arg) { ccode = pack(out, arg) || ccode; }(args), ...);
    return ccode;
}

template <typename... Args>
inline ErrorOr<Buffer> toData(const Args &...args) noexcept {
    Buffer out;
    if (auto ccode = toDataEx(out, args...)) return ccode;
    return out;
}

}  // namespace ap::memory
