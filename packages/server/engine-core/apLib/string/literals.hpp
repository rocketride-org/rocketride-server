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

namespace ap {

// Text literals
//	"blah"	<-- char_t (utf8/ascii)
//	u"blah"	<-- char16_t (ucs2/16)
//	U"blah"	<-- char32_t (utf32)
//	L"blah"	<-- windows utf16, linux utf32
inline Text operator"" _t(const char *str, std::size_t count) noexcept {
    return {str, count};
}
inline Text operator"" _utf8(const char *str, std::size_t count) noexcept {
    return {str, count};
}
inline Utf16 operator"" _utf16(const char16_t *str,
                               std::size_t count) noexcept {
    return {str, count};
}
inline Utf32 operator"" _utf32(const char32_t *str,
                               std::size_t count) noexcept {
    return {str, count};
}

#if ROCKETRIDE_PLAT_WIN
static_assert(sizeof(wchar_t) == 2, "Expected wchar_t size mismatch");
inline Utf16 operator"" _utf16(const wchar_t *str, std::size_t count) noexcept {
    return {str, count};
}
inline Utf16 operator"" _txtos(const wchar_t *str, std::size_t count) noexcept {
    return {str, count};
}
#else
static_assert(sizeof(wchar_t) == 4, "Expected wchar_t size mismatch");
inline Utf32 operator"" _utf32(const wchar_t *str, std::size_t count) noexcept {
    return {str, count};
}
#endif

constexpr TextView operator"" _tv(const Utf8Chr *str,
                                  std::size_t count) noexcept {
    return {str, count};
}
constexpr TextView operator"" _tv(const char8_t *str,
                                  std::size_t count) noexcept {
    return {str, count};
}
constexpr Utf16View operator"" _tv(const Utf16Chr *str,
                                   std::size_t count) noexcept {
    return {str, count};
}
#if ROCKETRIDE_PLAT_WIN
constexpr Utf16View operator"" _tv(const char16_t *str,
                                   std::size_t count) noexcept {
    return {str, count};
}
#endif
constexpr Utf32View operator"" _tv(const Utf32Chr *str,
                                   std::size_t count) noexcept {
    return {str, count};
}

constexpr iTextView operator"" _itv(const Utf8Chr *str,
                                    std::size_t count) noexcept {
    return {str, count};
}
constexpr iTextView operator"" _itv(const char8_t *str,
                                    std::size_t count) noexcept {
    return {str, count};
}
constexpr iUtf16View operator"" _itv(const Utf16Chr *str,
                                     std::size_t count) noexcept {
    return {str, count};
}
#if ROCKETRIDE_PLAT_WIN
constexpr iUtf16View operator"" _itv(const char16_t *str,
                                     std::size_t count) noexcept {
    return {str, count};
}
#endif
constexpr iUtf32View operator"" _itv(const Utf32Chr *str,
                                     std::size_t count) noexcept {
    return {str, count};
}

}  // namespace ap
