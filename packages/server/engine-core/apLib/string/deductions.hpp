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

// Deduce a char * => std::string_view
PackAdapter(const char *) -> PackAdapter<std::basic_string_view<char>>;

// Deduce a uint8_t * => std::basic_strin_view<uint8_t>
PackAdapter(const uint8_t *) -> PackAdapter<std::basic_string_view<uint8_t>>;

#if defined(ROCKETRIDE_PLAT_WIN)
// Deduce a char[]  => std::string_view
template <size_t LenT>
PackAdapter(const char[LenT]) -> PackAdapter<std::string_view>;

// Deduce a uint8_t[]  => std::basic_string_view<uint8_t
template <size_t LenT>
PackAdapter(const uint8_t[LenT])
    -> PackAdapter<std::basic_string_view<uint8_t>>;
#endif

// Deduce a char * => Utf8
StrView(const char *) -> StrView<Utf8Chr, std::char_traits<Utf8Chr>>;
Str(const char *)
    -> Str<Utf8Chr, std::char_traits<Utf8Chr>, std::allocator<Utf8Chr>>;

#if defined(ROCKETRIDE_PLAT_WIN)
// Deduce a char[]  => Utf8
template <size_t LenT>
StrView(const char[LenT]) -> StrView<Utf8Chr, std::char_traits<Utf8Chr>>;
template <size_t LenT>
Str(const char[LenT])
    -> Str<Utf8Chr, std::char_traits<Utf8Chr>, std::allocator<Utf8Chr>>;
#endif

// Deduce a uint8_t  => Utf8
StrView(const uint8_t *) -> StrView<Utf8Chr, std::char_traits<Utf8Chr>>;
Str(const uint8_t *)
    -> Str<Utf8Chr, std::char_traits<Utf8Chr>, std::allocator<Utf8Chr>>;

#if defined(ROCKETRIDE_PLAT_WIN)
// Deduce a uint8_t[]  => Utf8
template <size_t LenT>
StrView(const uint8_t[LenT]) -> StrView<Utf8Chr, std::char_traits<Utf8Chr>>;
template <size_t LenT>
Str(const uint8_t[LenT])
    -> Str<Utf8Chr, std::char_traits<Utf8Chr>, std::allocator<Utf8Chr>>;
#endif

// Deduce wchar_t depending on its width (linux - 4, windows - 2)
StrView(const wchar_t *)
    -> StrView<std::conditional<sizeof(wchar_t) == 2, Utf16Chr, Utf32Chr>>;
Str(const wchar_t *)
    -> Str<std::conditional<sizeof(wchar_t) == 2, Utf16Chr, Utf32Chr>>;

StrView(const wchar_t *, size_t len)
    -> StrView<std::conditional<sizeof(wchar_t) == 2, Utf16Chr, Utf32Chr>>;
Str(const wchar_t *, size_t len)
    -> Str<std::conditional<sizeof(wchar_t) == 2, Utf16Chr, Utf32Chr>>;

// Deduce a StrView from a DataView
template <typename DataT>
StrView(memory::DataView<DataT>) -> StrView<std::decay_t<DataT>>;

// Deduce a StrView from a Data
template <typename DataT, typename AllocT>
StrView(memory::Data<DataT, AllocT>) -> StrView<std::decay_t<DataT>>;

// Deduce a Str from a DataView
template <typename DataT>
Str(memory::DataView<DataT>) -> Str<std::decay_t<DataT>>;

// Deduce a Str from a Data
template <typename DataT, typename AllocT>
Str(memory::Data<DataT, AllocT>)
    -> Str<std::decay_t<DataT>, Case<std::decay_t<DataT>>, AllocT>;

}  // namespace ap::string
