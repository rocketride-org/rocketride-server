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
inline Error packBool(const T &arg, const FormatOptions &opts,
                      B &buff) noexcept {
    if (arg) return packString("true", opts, buff);
    return packString("false", opts, buff);
}

template <typename T, typename B>
inline Error packFloat(const T &arg, const FormatOptions &opts,
                       B &buff) noexcept {
    auto stream = opts.allocatePackStream<T>();

    stream << arg;

    if (stream.bad())
        return {Ec::StringParse, _location, "Failed to render float"};

    auto res = Text{stream.str()};
    if (res.contains(".")) {
        res.trimTrailing({'0'});
        if (res.endsWith(".")) res.pop_back();
    }
    buff << res;
    return {};
}

template <typename T, typename B>
inline Error packNumeric(const T &_arg, const FormatOptions &opts,
                         B &buff) noexcept {
    // Handle the size case by rendering it as a size and letting it output a
    // human size
    if (opts.sizeHuman()) {
        buff << Size(_arg);
        return {};
    }

    if (opts.countHuman()) {
        buff << Count(_arg);
        return {};
    }

    auto arg = _arg;
    auto fillChr = opts.fillChr<T>();
    auto groupChr = opts.groupChr();
    auto groupWidth = opts.groupWidth();
    auto prefix = opts.prefixStr();
    const char *sign = _arg < 0 ? "-" : nullptr;

    // Next convert the number to its raw string value, based on whether
    // it is hex or not, and perform grouping here as well, this works because
    // we order the number in reverse as we convert it
    std::array<TextChr, 128> numberStr;
    ptrdiff_t groupOffset = 1;
    auto numIter = numberStr.begin();

    auto absolute = [](auto num) noexcept {
        if constexpr (std::is_signed_v<T>)
            return std::abs(num);
        else
            return num;
    };

    do {
        if (opts.group()) {
            // If we're due for a grouping
            auto position = std::distance(numberStr.begin(), numIter);
            auto nextGroupPosition =
                (groupOffset * groupWidth) + (groupOffset - 1);
            if (position == nextGroupPosition) {
                *numIter++ = groupChr;
                groupOffset++;
            }
        }

        if (opts.hex()) {
            *numIter++ = "0123456789abcdef"[absolute(arg % 16)];
            arg = arg / 16;
        } else {
            *numIter++ = "0123456789"[absolute(arg % 10)];
            arg = arg / 10;
        }

        ASSERT(numIter != numberStr.end());
    } while (arg);

    // Grab the actual number length pre fill and minux the group chars
    auto numberSizeWithGroups =
        _cast<size_t>(std::distance(numberStr.begin(), numIter));
    auto numberSize = numberSizeWithGroups - (groupOffset - 1);

    // Save the start of the reverse portion where our number starts
    // as we did populate it in reverse
    auto numIterStart =
        numberStr.rbegin() + (numberStr.size() - numberSizeWithGroups);

    // Cap the length to the number size as we never cap the number
    // due to a length cap
    auto width = std::max(numberSize, opts.fillWidth<T>());

    // If we are not filling for one reason or another just copy the
    // result
    if (width <= numberSize || !opts.fill()) {
        if (sign) buff << *sign;
        buff << prefix;
        buff.write(numIterStart, numberSizeWithGroups);
        return {};
    }

    // So we're filling, determin the number of fill characters
    auto fillSize = width - numberSize;

    // Simply fill right, or left
    if (opts.rightJustify()) {
        // Right justified - <prefix><number><fill>
        //
        // Copy the whole number with prefix
        if (sign) buff << *sign;
        buff << prefix;
        buff.write(numIterStart, numberSizeWithGroups);

        // Next the fill characters
        buff.write(fillChr, fillSize);
    } else {
        // Left justified - <prefix><fill>number
        //
        // Copy the prefix
        if (sign) buff << *sign;
        buff << prefix;

        // Then the fill, if we're adding a prefix we need to continue the
        // grouping
        if (!prefix.empty() && opts.hex() && opts.zeroFill<T>() &&
            opts.group()) {
            for (auto i = 0; i < fillSize; i++) {
                auto position = std::distance(numberStr.begin(), numIter);
                auto nextGroupPosition =
                    (groupOffset * groupWidth) + (groupOffset - 1);
                if (position == nextGroupPosition) {
                    *numIter++ = groupChr;
                    groupOffset++;
                }

                *numIter++ = fillChr;
                ASSERT(numIter != numberStr.end());
            }

            // Update the iterator position and length
            numberSizeWithGroups = std::distance(numberStr.begin(), numIter);
            numberSize = numberSizeWithGroups - (groupOffset - 1);
            numIterStart =
                numberStr.rbegin() + (numberStr.size() - numberSizeWithGroups);
        } else {
            // Otherwise no grouping in the fill, just write it to the output
            buff.write(fillChr, fillSize);
        }

        // And then the number itself
        buff.write(numIterStart, numberSizeWithGroups);
    }

    return {};
}

template <typename T, typename B>
inline Error packByte(const T &arg, const FormatOptions &opts,
                      B &buff) noexcept {
    return packNumeric(arg, opts, buff);
}

template <typename T, typename B>
inline Error pack(const T &arg, const FormatOptions &opts, B &buff,
                  PackTag::Number) noexcept {
    if constexpr (PackTraits<T>::IsBool)
        return packBool(arg, opts, buff);
    else if constexpr (PackTraits<T>::IsFloat)
        return packFloat(arg, opts, buff);
    else if constexpr (PackTraits<T>::Size == 1)
        return packByte(arg, opts, buff);
    else
        return packNumeric(arg, opts, buff);
}

}  // namespace ap::string::internal
