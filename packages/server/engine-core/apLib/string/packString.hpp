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

namespace ap::string::internal {

template <typename T, typename B>
inline Error packStdPath(const T &arg, const FormatOptions &opts,
                         B &buff) noexcept {
    buff << arg.u8string();
    return {};
}

template <typename B>
inline Error packString(TextView arg, const FormatOptions &opts,
                        B &buff) noexcept {
    // We have a string size, and a width, we'll limit it to the total
    // string length (we never cap a value)
    auto stringLength = arg.size();
    if (auto fieldWidth = opts.width<TextView>(); fieldWidth)
        stringLength = std::min(stringLength, fieldWidth);
    auto fillCount = opts.fillWidth<TextView>(stringLength);

    // Now if right justify, we write the fill then the string
    if (opts.rightJustify()) {
        if (opts.fill()) buff.write(opts.fillChr<Text>(), fillCount);
        buff.write(arg.begin(), stringLength);
    }
    // Left is the reverse
    else {
        buff.write(arg.begin(), stringLength);
        if (opts.fill()) buff.write(opts.fillChr<Text>(), fillCount);
    }
    return {};
}

template <typename B>
inline Error packString(Utf16View arg, const FormatOptions &opts,
                        B &buff) noexcept {
    return packString(TextView{_tr<Text>(arg)}, opts, buff);
}

template <typename B>
inline Error packString(Utf32View arg, const FormatOptions &opts,
                        B &buff) noexcept {
    return packString(TextView{_tr<Text>(arg)}, opts, buff);
}

template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::String) noexcept {
    if constexpr (traits::IsSameTypeV<T, char>) {
        buff << arg;
        return {};
    } else if constexpr (PackTraits<T>::IsNull) {
        return packString("", opts, buff);
    } else if constexpr (traits::IsSameTypeV<T, std::filesystem::path>) {
        return packStdPath(arg, opts, buff);
    } else if constexpr (PackTraits<T>::IsUtf16StringPtr) {
        if (!arg) return {};
        return packString(arg, opts, buff);
    } else if constexpr (PackTraits<T>::IsUtf16String) {
        auto converted = _tr<Text>(arg);
        return packString(converted, opts, buff);
    } else if constexpr (PackTraits<T>::IsUtf8StringPtr) {
        if (!arg) return {};
        return packString(*arg, opts, buff);
    } else
        return packString(arg, opts, buff);
}

}  // namespace ap::string::internal
