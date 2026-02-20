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

#include "test.h"

TEST_CASE("string::encoding") {
    SECTION("Convert from wchar_t array") {
#if WIN32
        auto word = L"blaaaa";
        REQUIRE(Utf16{word}.size() == 6);
        REQUIRE(_tr<Text, Utf16View>(word) == "blaaaa");
        Utf16 u16word = L"Ã©Å¡Â±Ã¦â€Â¿Ã§Â­â€“.txt";
        LOG(Test, "{}", u16word);
        Text u8word = u16word;
        LOG(Test, "{}", u8word);
        Utf16 u16word2 = u8word;
        LOG(Test, "{}", u16word2);
        REQUIRE(u16word2 == u16word);
#else
        // For now this is disabled as we do not support Utf16->Utf32
        // conversions
        // @@TODO
        // auto word = L"blaaaa";
        // auto len = Utf32{ word }.size();
        // REQUIRE(Utf32{ word }.size() == 6);
        // auto converted = _tr<Utf32>(_tr<Text, Utf32View>(word));
        // REQUIRE(converted == L"blaaaa");
#endif
    }
}
