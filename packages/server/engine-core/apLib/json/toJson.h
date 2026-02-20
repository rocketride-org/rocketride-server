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

namespace ap::json {

template <typename T>
ErrorOr<Value> toJsonEx(const T &type) noexcept;

template <typename T>
Value toJson(const T &type) noexcept;

inline Text escape(TextView str) noexcept {
    Text retval;
    retval.reserve(str.length());
    for (auto ch : str) {
        switch (ch) {
            // List of characters to escape derived from
            // json::valueToQuotedStringN
            case '\"':
            case '\\':
                retval += '\\';
                retval += ch;
                break;

            case '\b':
                retval += "\\b";
                break;

            case '\f':
                retval += "\\f";
                break;

            case '\n':
                retval += "\\n";
                break;

            case '\r':
                retval += "\\r";
                break;

            case '\t':
                retval += "\\t";
                break;

            default:
                retval += ch;
                break;
        }
    }
    return retval;
}

inline Text unescape(TextView str) noexcept {
    Text retval;
    retval.reserve(str.length());
    for (auto strPos = str.data(), endPos = str.data() + str.length();
         strPos < endPos; ++strPos) {
        if (*strPos == '\\' && strPos + 1 < endPos) {
            switch (*(strPos + 1)) {
                case '\"':
                case '\\':
                    retval += *(strPos + 1);
                    break;

                case 'b':
                    retval += '\b';
                    break;

                case 'f':
                    retval += '\f';
                    break;

                case 'n':
                    retval += '\n';
                    break;

                case 'r':
                    retval += '\r';
                    break;

                case 't':
                    retval += '\t';
                    break;

                default:
                    retval += '\\';
                    // Decrement to cancel out the implicit increment below
                    --strPos;
                    break;
            }

            // Skip the '\' as well as the escaped character
            ++strPos;
        } else
            retval += *strPos;
    }
    return retval;
}

}  // namespace ap::json

// Aborts on error
#define _tj ::ap::json::toJson

// Checked version, returns ErrorOr<json::Value>
#define _tjc ::ap::json::toJsonEx

// Exception-aware version, returns json::Value but may throw
#define _tje *::ap::json::toJsonEx
