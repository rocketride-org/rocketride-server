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
// 	Global platform type definitions
//
#pragma once

namespace ap::plat {

// This enumeration is defined so that we can use the platform
// ids in various areas of our product that may have os specific
// resitrctions
APUTIL_DEFINE_ENUM(Type, 0, 3, Windows = _begin, Linux, Mac);

// This enumeration defines the OS class, useful for whether
// you need to change some behavior around windows vs unix
APUTIL_DEFINE_ENUM(Class, 0, 2, Win32 = _begin, Unix);

// Mapes an operating system string definition to a
// type enumeration value
inline Opt<Type> mapName(iTextView str) noexcept {
    size_t enumIndex = 0;
    for (const auto &name : TypeNames) {
        if (name == str) return EnumFrom<Type>(enumIndex);
        enumIndex++;
    }
    return {};
}

#if ROCKETRIDE_PLAT_WIN
_const auto IsWindows = true;
_const auto IsUnix = false;
_const auto IsLinux = false;
_const auto IsMac = false;
_const auto CurrentType = Type::Windows;
_const auto CurrentClass = Class::Win32;
_const auto CurrentName = "win"sv;
_const auto PathCaseMode = false;
_const auto LibraryExtension = "dll"sv;

template <typename ChrT>
using PathTrait = string::NoCase<ChrT>;

#elif ROCKETRIDE_PLAT_LIN
_const auto IsWindows = false;
_const auto IsUnix = true;
_const auto IsLinux = true;
_const auto IsMac = false;
_const auto CurrentType = Type::Linux;
_const auto CurrentClass = Class::Unix;
_const auto CurrentName = "lin"sv;
_const auto PathCaseMode = true;
_const auto LibraryExtension = "so"sv;

template <typename ChrT>
using PathTrait = string::Case<ChrT>;
#elif ROCKETRIDE_PLAT_MAC
_const auto IsWindows = false;
_const auto IsUnix = true;
_const auto IsLinux = false;
_const auto IsMac = true;
_const auto CurrentType = Type::Mac;
_const auto CurrentClass = Class::Unix;
_const auto CurrentName = "mac"sv;
_const auto PathCaseMode = false;
_const auto LibraryExtension = "dylib"sv;

template <typename ChrT>
using PathTrait = string::NoCase<ChrT>;
#else
#error "Unsupported platform"
#endif

#ifdef ROCKETRIDE_BUILD_DEBUG
_const auto IsDebug = true;
_const auto IsRelease = false;
#else
_const auto IsDebug = false;
_const auto IsRelease = true;
#endif

}  // namespace ap::plat
