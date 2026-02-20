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
inline Error packWithStream(const T &arg, const FormatOptions &opts,
                            B &buff) noexcept {
    auto stream = opts.allocatePackStream<T>();
    if constexpr (std::is_pointer_v<T>) {
        if (!arg) {
            buff << "{null}";
            return {};
        } else {
            stream << arg;
        }
    } else {
        stream << arg;
    }
    if (stream.fail())
        return Error{Ec::StringParse, _location,
                     "Failed to render with stream {}", util::typeName<T>()};
    buff.write(stream.str());
    return {};
}

template <typename B>
inline Error packTid(const async::Tid &arg, FormatOptions opts,
                     B &buff) noexcept {
    opts =
        opts + FormatOptions{Format::HEX | Format::FILL | Format::ZEROFILL, 4};
    auto stream = opts.allocatePackStream<uint32_t>();
    stream << arg;
    if (stream.fail())
        return Error{Ec::StringParse, _location, "Failed to render Tid"};
    buff << stream.str();
    return {};
}

template <typename T, typename B>
inline void packLocation(const T &arg, const FormatOptions &opts,
                         B &buff) noexcept {
    arg.toString(buff, false);
}

template <typename T, typename B>
inline void packFrame(const T &arg, const FormatOptions &opts,
                      B &buff) noexcept {
    buff << boost::stacktrace::to_string(arg);
}

template <typename T, typename B>
inline auto packChronoDuration(const T &arg, const FormatOptions &opts,
                               B &buff) noexcept {
    return time::Duration{arg}.__toString(buff, opts);
}

template <typename T, typename B>
inline Error packStdException(const T &arg, const FormatOptions &opts,
                              B &buff) noexcept {
    if (auto e = dynamic_cast<const Error *>(&arg); e) return _tsb(buff, e);
    if (auto e = dynamic_cast<const std::logic_error *>(&arg); e)
        return _tsb(buff, "std::logic_error: ", e->what());

    if (auto e = dynamic_cast<const std::invalid_argument *>(&arg); e)
        return _tsb(buff, "std::invalid_argument: ", e->what());

    if (auto e = dynamic_cast<const std::domain_error *>(&arg); e)
        return _tsb(buff, "std::domain_error: ", e->what());

    if (auto e = dynamic_cast<const std::length_error *>(&arg); e)
        return _tsb(buff, "std::length_error: ", e->what());

    if (auto e = dynamic_cast<const std::out_of_range *>(&arg); e)
        return _tsb(buff, "std::out_of_range: ", e->what());

    if (auto e = dynamic_cast<const std::runtime_error *>(&arg); e)
        return _tsb(buff, "std::runtime_error: ", e->what());

    if (auto e = dynamic_cast<const std::range_error *>(&arg); e)
        return _tsb(buff, "std::range_error: ", e->what());

    if (auto e = dynamic_cast<const std::overflow_error *>(&arg); e)
        return _tsb(buff, "std::overflow_error: ", e->what());

    if (auto e = dynamic_cast<const std::underflow_error *>(&arg); e)
        return _tsb(buff, "std::underflow_error: ", e->what());

    if (auto e = dynamic_cast<const std::bad_alloc *>(&arg); e)
        return _tsb(buff, "std::bad_alloc: ", e->what());

    if (auto e = dynamic_cast<const std::exception *>(&arg); e)
        return _tsb(buff, "std::exception: ", e->what());

    return _tsb(buff, "(", util::typeName<T>(), ") ", arg.what());
}

template <typename T, typename B>
inline Error packPtr(const T &arg, const FormatOptions &opts,
                     B &buff) noexcept {
    if (!arg) {
        buff << "{nullptr}";
        return {};
    }
    return pack<decltype(*arg), B>(*arg, opts, buff,
                                   detectPackTag<decltype(*arg), B>());
}

template <typename T, typename B>
inline Error packWeakPtr(const T &arg, const FormatOptions &opts,
                         B &buff) noexcept {
    auto _arg = arg.lock();
    if (!_arg) {
        buff << "{nullptr}";
        return {};
    }
    return pack<decltype(*_arg), B>(*_arg, opts, buff,
                                    detectPackTag<decltype(*_arg), B>());
}

template <typename T, typename B>
inline Error packOptional(const T &arg, const FormatOptions &opts,
                          B &buff) noexcept {
    if (!arg) return {};
    return pack<decltype(*arg), B>(*arg, opts, buff,
                                   detectPackTag<decltype(*arg), B>());
}

template <typename T, typename B>
inline void packNull(const T &arg, const FormatOptions &opts,
                     B &buff) noexcept {
    buff << "{nullptr}";
}

template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::Misc) noexcept {
    if constexpr (traits::IsPairV<T>) {
        if (auto ccode = packSelector(arg.first, opts, buff); ccode)
            return ccode;

        buff << opts.delimiter(' ');

        return packSelector(arg.second, opts, buff);
    } else if constexpr (traits::IsAtomicV<T>) {
        auto val = arg.load();
        return packSelector(val, opts, buff);
    } else if constexpr (traits::IsSameTypeV<T, Location>) {
        packLocation(arg, opts, buff);
        return {};
    } else if constexpr (traits::IsSameTypeV<T, boost::stacktrace::frame>) {
        packFrame(arg, opts, buff);
        return {};
    } else if constexpr (PackTraits<T>::IsChronoDuration) {
        return packChronoDuration(arg, opts, buff);
    } else if constexpr (std::is_convertible_v<T, const std::exception &>) {
        return packStdException(arg, opts, buff);
    } else if constexpr (traits::IsSameTypeV<async::SystemTid, T>) {
        return pack(_reCast<uintptr_t>(arg), opts, buff, PackTag::Number{});
    } else if constexpr (traits::IsOptionalV<T>) {
        return packOptional(arg, opts, buff);
    } else if constexpr (std::is_null_pointer_v<T>) {
        return packNull(arg, opts, buff);
    } else if constexpr (traits::IsSameTypeV<Lvl, T>) {
        log::__toString(arg, buff);
        return {};
    } else if constexpr (traits::IsSameTypeV<T, std::error_code>) {
        buff << arg.category().name() << ":"
             << string::toHex(_cast<uint32_t>(arg.value()));
        return {};
    } else if constexpr (traits::IsSameTypeV<T, time::SystemStamp>) {
        buff << time::formatDateTime(arg);
        return {};
    } else if constexpr (traits::IsSameTypeV<T, InitList<TextView>>) {
        bool delim = false;
        for (auto &entry : arg) {
            if (_exch(delim, true) && opts.delimiter())
                buff << opts.delimiter();
            buff << entry;
        }
        return {};
    } else if constexpr (traits::IsSameTypeV<async::Tid, T>) {
        return packTid(arg, opts, buff);
    } else if constexpr (traits::IsSmartPtrV<T> || std::is_pointer_v<T>) {
        if constexpr (traits::IsWeakPtrV<T>)
            return packWeakPtr(arg, opts, buff);
        else
            return packPtr(arg, opts, buff);
    } else if constexpr (traits::IsSameTypeV<T, std::filesystem::path>) {
        buff << arg.generic_u8string();
        return {};
    } else if constexpr (traits::IsDetected<DetectToStringMethod, T>{}) {
        buff << _ts(arg.to_string());
        return {};
    } else if constexpr (PackTraits<T>::HasStreamOut) {
        return packWithStream(arg, opts, buff);
    } else if constexpr (traits::IsSameTypeV<
                             T, std::basic_string<
                                    char, file::PathTrait<char, string::NoCase>,
                                    std::allocator<char>>>) {
        buff << TextView{arg.data(), arg.size()};
        return {};
    } else {
        // Attempt json if rtti or json are allowed and the type has a tojson
        // overload
        if (opts.jsonOk() || opts.rttiOk()) {
            if constexpr (traits::IsDetectedExact<
                              void, json::DetectToJsonMethod, T>{} ||
                          traits::IsDetectedExact<
                              Error, json::DetectToJsonMethod, T>{} ||
                          json::HasSchemaV<T>) {
                if (auto res = _tjc(arg)) {
                    buff.write(res->stringify(true));
                    return {};
                }
            }
        }

        // Fall back to an rtti render if enabled
        if (opts.rttiOk()) {
            buff.write(util::typeName<std::decay_t<std::remove_cv_t<T>>>());
            return {};
        }

        return APERR(Ec::Bug, "No way to render type:", util::typeName<T>());
    }
}

}  // namespace ap::string::internal
