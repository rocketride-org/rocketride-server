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

namespace ap::string {

// Pack adapter forwards any << operations back through the
// string pack system, this allows any type defined in our
// string hook meta api will work when streaming into
// a dPackAdapter adapter
template <typename BackingT>
template <typename Input, typename D, typename>
inline PackAdapter<BackingT> &PackAdapter<BackingT>::operator<<(
    Input &&input) noexcept {
    using InputTraits = internal::PackTraits<Input>;

    if constexpr (internal::detectPackMethod<Error, Input, decltype(*this)>())
        *input.__toString(*this);
    else if constexpr (internal::detectPackMethod<void, Input,
                                                  decltype(*this)>())
        input.__toString(*this);
    else if constexpr (internal::detectPackFunction<void, Input,
                                                    decltype(*this)>())
        __toString(std::forward<Input>(input), *this);
    else if constexpr (std::is_convertible_v<Input, char_type> &&
                       sizeof(char_type) == sizeof(Input))
        write(_cast<char_type>(input));
    else if constexpr (InputTraits::IsClassString) {
        if constexpr (sizeof(char_type) == sizeof(char) &&
                          InputTraits::IsUtf8String ||
                      InputTraits::IsUtf8Chr) {
            if constexpr (InputTraits::IsChar)
                write(_cast<char_type>(input));
            else if constexpr (traits::IsStrV<Input> ||
                               traits::IsStrViewV<Input> ||
                               InputTraits::IsStdString ||
                               InputTraits::IsStdStringView)
                write({_cast<const char_type *>(input.data()), input.size()});
            else if constexpr (InputTraits::IsUtf8StringPtr ||
                               std::is_convertible_v<Input, const char *>)
                write(_cast<const char *>(input));
            else
                static_assert(
                    sizeof(Input) == 0,
                    "Unsupported string type for PackAdapter << overload");
        } else if constexpr (InputTraits::IsUtf8String)
            write(input);
        else if constexpr (InputTraits::IsUtf16String)
            write(_tr<Text>(input));
        else if constexpr (std::is_convertible_v<Input, const char *>)
            write(_cast<const char *>(input));
        else
            static_assert(
                sizeof(Input) == 0,
                "Unsupported string encoding for PackAdapter << overload");
    } else if constexpr (InputTraits::IsClassNumber)
        *_tsb(*this, input);
    else if constexpr (InputTraits::HasStreamOut)
        *internal::packWithStream(input, {}, *this);
    else
        write(std::forward<Input>(input));
    return *this;
}

}  // namespace ap::string
