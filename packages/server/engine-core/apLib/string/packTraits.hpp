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
//	Pack conversion traits
//
#pragma once

namespace ap::string::internal {

template <typename ArgType>
struct PackTraits {
    using Type = std::decay_t<std::remove_cv_t<ArgType>>;
    using TypeNoPtr =
        std::decay_t<std::remove_cv_t<std::remove_pointer_t<ArgType>>>;

    _const auto Size = sizeof(Type);

    _const auto IsIntegral = std::is_integral_v<Type>;
    _const auto IsSigned = std::is_signed_v<Type>;
    _const auto IsFloat = std::is_floating_point_v<Type>;
    _const auto IsBool = traits::IsBoolV<Type>;

    _const auto IsDword = std::is_same_v<Type, uint32_t>;
    _const auto IsQword = std::is_same_v<Type, uint64_t>;
    _const auto IsByte = std::is_same_v<Type, uint8_t>;
    _const auto IsError = std::is_same_v<Type, Error>;

    _const auto IsStdString = std::is_same_v<Type, std::string>;
    _const auto IsStdStringView = std::is_same_v<Type, std::string_view>;

    _const auto IsText = std::is_same_v<Type, Text>;
    _const auto IsTextView = std::is_same_v<Type, TextView>;

    _const auto IsUtf16 = std::is_same_v<Type, Utf16>;
    _const auto IsUtf16View = std::is_same_v<Type, Utf16View>;

    _const auto IsStdWString = std::is_same_v<Type, std::wstring>;
    _const auto IsStdWStringView = std::is_same_v<Type, std::wstring_view>;

    _const auto IsChar = std::is_same_v<Type, char>;
    _const auto IsWChar = std::is_same_v<Type, wchar_t>;

    _const auto IsUtf8Chr = std::is_same_v<Type, Utf8Chr> || IsChar;
    _const auto IsUtf16Chr = std::is_same_v<Type, Utf16Chr>;

    _const auto IsNull = std::is_null_pointer_v<Type>;

    _const auto IsUtf8String = traits::IsSameTypeV<Type, const char *> ||
                               traits::IsSameTypeV<Type, const char *> ||
                               std::is_base_of_v<std::string, Type> ||
                               IsStdString || IsStdStringView || IsTextView ||
                               IsText;

    _const auto IsUtf16String =
#if ROCKETRIDE_PLAT_WIN
        traits::IsSameTypeV<Type, const wchar_t *> ||
        std::is_base_of_v<std::wstring, Type> || IsStdWString ||
        IsStdWStringView ||
#endif
        traits::IsSameTypeV<Type, const char16_t *> || IsUtf16View || IsUtf16;

    _const auto IsStringable =
        std::is_convertible_v<Type, const char *> ||
        std::is_convertible_v<Type, const wchar_t *> ||
        std::is_convertible_v<Type, const std::string &> ||
        std::is_convertible_v<Type, std::string> ||
        std::is_convertible_v<Type, std::string_view> ||
        std::is_same_v<Type, char> || IsStdString || IsStdStringView ||
        IsUtf16 || IsUtf16View || IsText || IsTextView;

    _const auto IsUtf8StringPtr =
        std::is_pointer_v<Type> &&
        (std::is_base_of_v<std::string, TypeNoPtr> ||
         std::is_base_of_v<std::string_view, TypeNoPtr>);

    _const auto IsUtf16StringPtr =
        std::is_pointer_v<Type> &&
        (
#if ROCKETRIDE_PLAT_WIN
            std::is_base_of_v<std::wstring, TypeNoPtr> ||
            std::is_base_of_v<std::basic_string_view<wchar_t>, TypeNoPtr> ||
#endif
            std::is_base_of_v<std::basic_string<char16_t>, TypeNoPtr> ||
            std::is_base_of_v<std::basic_string_view<char16_t>, TypeNoPtr>);

    _const auto IsChronoDuration = traits::IsChronoDurationV<Type>;

    _const auto IsContainer =
        traits::IsContainerV<Type> || traits::IsTupleV<Type>;
    _const auto IsSequenceContainer = traits::IsSequenceContainerV<Type>;
    _const auto IsTuple = traits::IsTupleV<Type>;

    _const auto HasStreamOut =
        traits::HasStreamOutOverloadV<std::stringstream, Type>;
    _const auto HasStreamIn =
        traits::HasStreamInOverloadV<std::stringstream, Type>;
    _const auto IsOptional = traits::IsOptionalV<Type>;
    _const auto IsSmartPtr =
        traits::IsSharedPtrV<Type> || traits::IsUniquePtrV<Type>;

    _const auto IsException =
        std::is_convertible_v<Type, const std::exception &>;

    _const std::array DecimalWidthMap{0, 3, 5, 0, 10, 0, 0, 0, 20};

    _const size_t HexWidth = (IsIntegral ? Size * 2 : 0);
    _const size_t DecimalWidth = (IsIntegral ? DecimalWidthMap[Size] : 0);

    _const auto IsClassString = IsStringable || IsUtf8String || IsUtf16String ||
                                IsUtf8StringPtr || IsUtf16StringPtr;
    _const auto IsClassNumber =
        !IsClassString && (IsIntegral || IsFloat || IsBool);
    _const auto IsClassContainer =
        !IsClassString && !IsClassNumber && IsContainer;
    _const auto IsClassMisc =
        !IsClassString && !IsClassNumber && !IsClassContainer;
};

}  // namespace ap::string::internal
