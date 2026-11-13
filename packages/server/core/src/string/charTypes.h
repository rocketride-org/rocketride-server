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

// Define the underlying storage for a Utf16 character
using Utf16Chr = std::conditional_t<sizeof(wchar_t) == 2, wchar_t, char16_t>;
static_assert(sizeof(Utf16Chr) == 2, "Invalid Utf16Chr definition");

// Define the underlying storage for a Utf32 character
using Utf32Chr = std::conditional_t<sizeof(wchar_t) == 4, wchar_t, char32_t>;
static_assert(sizeof(Utf32Chr) == 4, "Invalid Utf32Chr definition");

// Define the underlying storage for a Utf8 character
using Utf8Chr = char;

// Defines the basic unit in which to store a character in Text
// strings.
using TextChr = Utf8Chr;

#if ROCKETRIDE_PLAT_WIN
using OsChr = wchar_t;
#else
using OsChr = char;
#endif

}  // namespace ap
