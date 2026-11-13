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

template <typename T, typename B>
inline Error unpackFloat(T &arg, const FormatOptions &opts,
                         const B &buff) noexcept {
    if (buff.empty())
        return {Ec::StringParse, _location,
                "Cannot convert empty string to float"};

    // Posix iostream doesn't like non numeric characters so cap at the first
    // non numeric/punctuation character
    auto input = buff.toString();
    size_t start = 0;
    if (opts.hex()) {
        if (!input.startsWith("0x", false)) input = "0x" + input;
        start = 2;
    }
    for (auto i = start; i < input.size(); i++) {
        if (!std::isdigit(input[i]) && !std::ispunct(input[i])) {
            input = input.substr(0, i);
            break;
        }
    }

    auto stream = opts.allocateUnpackStream<T>();
    stream << input;
    if (opts.hex())
        stream >> std::hexfloat >> arg;
    else
        stream >> arg;
    if (stream.bad())
        return {Ec::StringParse, _location,
                "Failed to unpack float: {} Arg: {}", input, arg};
    return {};
}

template <typename T, typename B>
inline Error unpackBool(T &arg, const FormatOptions &opts,
                        const B &buff) noexcept {
    if (buff.empty())
        return {Ec::StringParse, _location,
                "Cannot convert empty string to boolean"};

    switch (*buff) {
        case 'T':
        case 't':
        case '1':
        case 'y':
        case 'Y':
            arg = true;
            return {};

        case 'F':
        case 'f':
        case '0':
        case 'n':
        case 'N':
            arg = false;
            return {};
    }

    return {Ec::StringParse, _location, "Failed to unpack boolean from string"};
}

template <typename T, typename B>
inline Error unpackIntegral(T &arg, const FormatOptions &opts,
                            const B &buff) noexcept {
    // Previously, it was an error to unpack a zero length string,
    // however, it has been changed to "" = 0
    if (buff.empty()) {
        arg = 0;
        return {};
    }

    arg = 0;
    auto inputRemaining = buff.size();
    auto input = buff.slice();
    auto flags = opts.flags();
    auto length = opts.width<T>();
    auto negative = false;

    // Handle the signedness  at the start
    if constexpr (std::is_signed_v<T>) {
        if (inputRemaining > 1 && *input == '-') {
            std::advance(input, 1);
            inputRemaining -= 1;
            negative = true;
        }
    }

    // If it has leading 0x, skip it
    if (inputRemaining > 1 && *input == '0' && *(input + 1) == 'x') {
        std::advance(input, 2);
        inputRemaining -= 2;
        flags |= Format::HEX;
    }

    // Go until end of string of 16 characters
    while (inputRemaining && length) {
        // Uppercase it
        auto chr = static_cast<TextChr>(toupper(*input));

        // Check for grouping
        if (flags & Format::HEX) {
            // If it is a separator, assume grouping
            if (chr == ':') {
                input++;
                inputRemaining--;
                continue;
            }

            // If it is in the numeric range
            if (chr >= '0' && chr <= '9') {
                // Shift it in
                arg = (arg << 4) + (chr - '0');

                // Next
                input++;
                length--;
                inputRemaining--;
                continue;
            }

            // If it is in the numeric range
            if (chr >= 'A' && chr <= 'F') {
                // Shift it in
                arg = (arg << 4) + ((chr - 'A') + 10);

                // Next
                input++;
                length--;
                inputRemaining--;
                continue;
            }

            // It is not a hex digit, nor a hex grouping character (.)
            break;
        } else {
            // If it is a separator, assume grouping
            if (chr == ',') {
                input++;
                inputRemaining--;
                continue;
            }

            // If it is in the numeric range
            if (chr >= '0' && chr <= '9') {
                // Shift it in
                arg = arg * 10 + (chr - '0');

                // Next
                input++;
                length--;
                inputRemaining--;
                continue;
            }

            // It is not a numeric chr, nor a decimal grouping character (,)
            break;
        }
    }

    // Make negative now if needed
    if (negative) {
        if constexpr (std::is_signed_v<T>) arg = -arg;
    }

    return {};
}

template <typename T, typename B>
inline Error unpack(T &arg, const FormatOptions &opts, const B &buff,
                    PackTag::Number) noexcept {
    if constexpr (PackTraits<T>::IsFloat)
        return unpackFloat(arg, opts, buff);
    else if constexpr (PackTraits<T>::IsBool)
        return unpackBool(arg, opts, buff);
    else
        return unpackIntegral(arg, opts, buff);
}

}  // namespace ap::string::internal
