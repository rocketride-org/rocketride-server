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

namespace ap::string::internal {

template <typename B>
inline Error unpackSystemStamp(time::SystemStamp &stamp,
                               const FormatOptions &opts, B &buf) noexcept {
    time_t epoch;

    // We accept two forms, seconds since epoch (hex or otherwise), or
    // human date time format in either ISO8601 format our default format
    if (auto ccode = unpackIntegral(epoch, opts, buf)) {
        auto res =
            time::parseDateTime(buf.toString(), time::ISO_8601_DATE_TIME_FMT);
        if (!res) res = time::parseDateTime(buf.toString(), time::DEF_FMT);
        if (!res) return ccode;
        stamp = _mv(*res);
        return {};
    }

    stamp = time::Clock::System::from_time_t(epoch);
    return {};
}

template <typename T, typename B>
inline Error unpackOptional(T &arg, const FormatOptions &opts,
                            B &buf) noexcept {
    if (buf.empty()) {
        arg = NullOpt;
        return {};
    }

    return unpackSelector(arg.emplace(), opts, buf);
}

template <typename T, typename B>
inline Error unpack(T &arg, const FormatOptions &opts, B &buf,
                    PackTag::Misc) noexcept {
    if constexpr (traits::IsSameTypeV<T, Lvl>) {
        return log::__fromString(arg, buf);
    } else if constexpr (traits::HasStreamInOverloadV<std::stringstream, T>) {
        return _callChk([&]() noexcept(false) -> Error {
            auto stream = opts.allocateUnpackStream<T>();
            stream << buf.toString();
            stream >> arg;
            if (stream.fail())
                return {Ec::StringParse, _location,
                        "Failed to parse type:", util::typeName<T>()};
            return {};
        });
    } else if constexpr (traits::IsSameTypeV<T, time::SystemStamp>) {
        return unpackSystemStamp(arg, opts, buf);
    } else if constexpr (traits::IsOptionalV<T>) {
        return unpackOptional(arg, opts, buf);
    } else
        return APERRL(Always, Ec::Bug,
                      "No way to pack type:", util::typeName<T>());
}

}  // namespace ap::string::internal
