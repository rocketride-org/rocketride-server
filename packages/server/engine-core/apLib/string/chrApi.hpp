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

// Generic low level ptr based string apis with string view which perfectly
// emulate their c counterparts they replace with stronger type saftey
// and bounds checking with templated character type handling
#pragma once

namespace ap::string {

// Determine the length of a string view
template <typename ChrT, typename TraitT>
inline decltype(auto) Strlen(StrView<ChrT, TraitT> str) noexcept {
    return str.size();
}

// Compares two string views lexographically
template <typename ChrT, typename TraitT>
inline decltype(auto) Strcmp(StrView<ChrT, TraitT> str1,
                             StrView<ChrT, TraitT> str2) noexcept {
    return str1.compare(str2);
}

// Compares two string views lexographically, without case for ascii
// characters (trait dependant)
template <typename ChrT, typename TraitT>
inline decltype(auto) Stricmp(StrView<ChrT, TraitT> str1,
                              StrView<ChrT, TraitT> str2) noexcept {
    return NoCase<ChrT>::compare(str1.data(), str2.data(),
                                 std::min(str1.size() + 1, str2.size() + 1));
}

// Compares two string views lexographically, with a hard limit on the
// character count to include in the comparison
template <typename ChrT, typename TraitT>
inline decltype(auto) Strncmp(StrView<ChrT, TraitT> str1,
                              StrView<ChrT, TraitT> str2, size_t cnt) noexcept {
    return TraitT::compare(str1.data(), str2.data(),
                           std::min(std::min(str1.size(), str2.size()), cnt));
}

// Check whether two strings views are equal
template <typename ChrT, typename TraitT>
inline decltype(auto) Streql(StrView<ChrT, TraitT> str1,
                             StrView<ChrT, TraitT> str2) noexcept {
    return Strcmp<ChrT, TraitT>(str1, str2) == 0;
}

// Check whether two strings views are equal, without considering case
// (ascii usually, trait dependent however)
template <typename ChrT, typename TraitT>
inline decltype(auto) Strieql(StrView<ChrT, TraitT> str1,
                              StrView<ChrT, TraitT> str2) noexcept {
    return Stricmp<ChrT, TraitT>(str1, str2) == 0;
}

// Locate a character within the string view
template <typename ChrT, typename TraitT>
inline const ChrT *Strchr(StrView<ChrT, TraitT> str1, ChrT chr) noexcept {
    if (auto pos = str1.find(chr); pos != StrView<ChrT, TraitT>::npos)
        return &str1.at(pos);
    return nullptr;
}

// Concatinate a strview to a destination character type of same width.
// The dest string must be null terminated, otherwise this will crash.
template <typename ChrT, typename TraitT, typename DestChrT>
inline auto Strcat(DestChrT *dest, StrView<ChrT, TraitT> source) noexcept {
    static_assert(sizeof(DestChrT) == sizeof(ChrT),
                  "Incorrect size type for copy target");
    auto destCast = reinterpret_cast<ChrT *>(dest);

    auto ptr =
        TraitT::find(destCast, std::numeric_limits<size_t>::max(), ChrT(0));
    return TraitT::copy(const_cast<ChrT *>(ptr), source.data(), source.size());
}

// Copy a string views contents into a destination character ptr
template <typename ChrT, typename TraitT, typename DestChrT>
inline auto Strcpy(DestChrT *dest, size_t len,
                   StrView<ChrT, TraitT> source) noexcept {
    static_assert(sizeof(DestChrT) == sizeof(ChrT),
                  "Incorrect siz type for copy target");
    return TraitT::copy(reinterpret_cast<ChrT *>(dest), source.data(),
                        std::min(source.size() + 1, len));
}

}  // namespace ap::string

namespace ap {

#define Utf8len \
    ::ap::string::Strlen<::ap::Utf8Chr, std::char_traits<::ap::Utf8Chr>>
#define Utf8cmp \
    ::ap::string::Strcmp<::ap::Utf8Chr, std::char_traits<::ap::Utf8Chr>>
#define Utf8icmp \
    ::ap::string::Stricmp<::ap::Utf8Chr, std::char_traits<::ap::Utf8Chr>>
#define Utf8ncmp \
    ::ap::string::Strncmp<::ap::Utf8Chr, std::char_traits<::ap::Utf8Chr>>
#define Utf8cpy \
    ::ap::string::Strcpy<::ap::Utf8Chr, std::char_traits<::ap::Utf8Chr>>
#define Utf8chr \
    ::ap::string::Strchr<::ap::Utf8Chr, std::char_traits<::ap::Utf8Chr>>
#define Utf8cat \
    ::ap::string::Strcat<::ap::Utf8Chr, std::char_traits<::ap::Utf8Chr>>
#define Utf8eql \
    ::ap::string::Streql<::ap::Utf8Chr, std::char_traits<::ap::Utf8Chr>>
#define Utf8ieql \
    ::ap::string::Strieql<::ap::Utf8Chr, std::char_traits<::ap::Utf8Chr>>

#define Utf16len \
    ::ap::string::Strlen<::ap::Utf16Chr, std::char_traits<::ap::Utf16Chr>>
#define Utf16cmp \
    ::ap::string::Strcmp<::ap::Utf16Chr, std::char_traits<::ap::Utf16Chr>>
#define Utf16icmp \
    ::ap::string::Stricmp<::ap::Utf16Chr, std::char_traits<::ap::Utf16Chr>>
#define Utf16ncmp \
    ::ap::string::Strncmp<::ap::Utf16Chr, std::char_traits<::ap::Utf16Chr>>
#define Utf16cpy \
    ::ap::string::Strcpy<::ap::Utf16Chr, std::char_traits<::ap::Utf16Chr>>
#define Utf16chr \
    ::ap::string::Strchr<::ap::Utf16Chr, std::char_traits<::ap::Utf16Chr>>
#define Utf16cat \
    ::ap::string::Strcat<::ap::Utf16Chr, std::char_traits<::ap::Utf16Chr>>
#define Utf16eql \
    ::ap::string::Streql<::ap::Utf16Chr, std::char_traits<::ap::Utf16Chr>>
#define Utf16ieql \
    ::ap::string::Strieql<::ap::Utf16Chr, std::char_traits<::ap::Utf16Chr>>

#define Utf32len \
    ::ap::string::Strlen<::ap::Utf32Chr, std::char_traits<::ap::Utf32Chr>>
#define Utf32cmp \
    ::ap::string::Strcmp<::ap::Utf32Chr, std::char_traits<::ap::Utf32Chr>>
#define Utf32icmp \
    ::ap::string::Stricmp<::ap::Utf32Chr, std::char_traits<::ap::Utf32Chr>>
#define Utf32ncmp \
    ::ap::string::Strncmp<::ap::Utf32Chr, std::char_traits<::ap::Utf32Chr>>
#define Utf32cpy \
    ::ap::string::Strcpy<::ap::Utf32Chr, std::char_traits<::ap::Utf32Chr>>
#define Utf32chr \
    ::ap::string::Strchr<::ap::Utf32Chr, std::char_traits<::ap::Utf32Chr>>
#define Utf32cat \
    ::ap::string::Strcat<::ap::Utf32Chr, std::char_traits<::ap::Utf32Chr>>
#define Utf32eql \
    ::ap::string::Streql<::ap::Utf32Chr, std::char_traits<::ap::Utf32Chr>>
#define Utf32ieql \
    ::ap::string::Strieql<::ap::Utf32Chr, std::char_traits<::ap::Utf32Chr>>

#define Txtlen Utf8len
#define Txtcmp Utf8cmp
#define Txticmp Utf8icmp
#define Txtncmp Utf8ncmp
#define Txtcpy Utf8cpy
#define Txtchr Utf8chr
#define Txtcat Utf8cat
#define Txteql Utf8eql
#define Txtieql Utf8ieql

}  // namespace ap
