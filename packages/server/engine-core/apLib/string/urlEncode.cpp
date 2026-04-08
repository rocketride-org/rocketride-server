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
//	URL encoding
//
#include <apLib/ap.h>

namespace ap::string {

//---------------------------------------------------------------------
/// @details
///		Does URL encoding
///	@param[in]	input
///		String to URL encode
///	@param[in]	encodeSlash
///		Whether or not to encode slash symbol ('/'). By standard, slash symbol
/// should be encoded.
///     If full SMB filepath is encoded, it shouldn't be the done.
///     Default value is false.
///	@returns
///		Text URL encoded string
//---------------------------------------------------------------------
Text urlEncode(TextView input, bool encodeSlash) noexcept {
    const char hexLetters[] = "0123456789ABCDEF";
    Text result;
    result.reserve(input.length());

    for (size_t i = 0, n = input.length(); i != n; ++i) {
        auto c = input[i];
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z') || c == '-' || c == '_' || c == '.' ||
            c == '~' || (c == '/' && encodeSlash == false)) {
            result.append(c);
        } else {
            // this unsigned char cast allows us to handle unicode characters.
            result.append('%');
            result.append(hexLetters[(c >> 4) & 0xF]);
            result.append(hexLetters[c & 0xF]);
        }
    }

    return result;
}

}  // namespace ap::string
