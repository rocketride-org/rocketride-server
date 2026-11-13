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

_const auto NoPos = std::string::npos;
_const auto CurPos = NoPos - 1;
_const auto EndPos = NoPos - 2;
_const auto BegPos = NoPos - 3;
_const auto CurOrEndPos = NoPos - 4;
_const auto CurOrBegPos = NoPos - 5;

// Define the underlying storage for a Utf16 character
using Utf16 = string::Str<Utf16Chr>;
using Utf16View = Utf16::ViewType;
using iUtf16 = string::Str<Utf16Chr, string::NoCase<Utf16Chr>>;
using iUtf16View = iUtf16::ViewType;

// Define the underlying storage for a Utf32 character
using Utf32 = string::Str<Utf32Chr>;
using Utf32View = Utf32::ViewType;
using iUtf32 = string::Str<Utf32Chr, string::NoCase<Utf32Chr>>;
using iUtf32View = iUtf32::ViewType;

// Define the underlying storage for a Utf8 character
using Utf8 = string::Str<Utf8Chr>;
using Utf8View = Utf8::ViewType;
using iUtf8 = string::Str<Utf8Chr, string::NoCase<Utf8Chr>>;
using iUtf8View = iUtf8::ViewType;

// Defines the basic unit in which to store a character in Text
// strings.
using Text = Utf8;
using TextView = Utf8View;

using iText = iUtf8;
using iTextView = iUtf8View;

}  // namespace ap
