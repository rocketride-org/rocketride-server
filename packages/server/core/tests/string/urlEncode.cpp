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

#include "test.h"

// Coverage for the tostring suite of apis
TEST_CASE("string::urlEncode") {
    SECTION("Simple strings") {
        REQUIRE(ap::string::urlEncode("test") == "test");
        REQUIRE(ap::string::urlEncode("ThisIsATest") == "ThisIsATest");
    }

    SECTION("String with space") {
        REQUIRE(ap::string::urlEncode("test string") == "test%20string");
        REQUIRE(ap::string::urlEncode("This Is A Test") ==
                "This%20Is%20A%20Test");
    }

    SECTION("String with slash to bypass") {
        REQUIRE(ap::string::urlEncode("test/string") == "test/string");
        REQUIRE(ap::string::urlEncode("This/Is/A/Test") == "This/Is/A/Test");
    }

    SECTION("String with slash to encode") {
        REQUIRE(ap::string::urlEncode("test/string", true) == "test%2Fstring");
        REQUIRE(ap::string::urlEncode("This/Is/A/Test", true) ==
                "This%2FIs%2FA%2FTest");
    }

    SECTION("Filename") {
        REQUIRE(ap::string::urlEncode(
                    "1096-9888(200006)35:6<659::aid-jms5>3.0.co;2-v.pdf") ==
                "1096-9888%28200006%2935%3A6%3C659%3A%3Aaid-jms5%3E3.0.co%3B2-"
                "v.pdf");
        REQUIRE(ap::string::urlEncode("1096-9888%28200006%2935%3A6%3C659%3A%"
                                      "3Aaid-jms5%3E3.0.co%3B2-v.pdf") ==
                "1096-9888%2528200006%252935%253A6%253C659%253A%253Aaid-jms5%"
                "253E3.0.co%253B2-v.pdf");
    }
}
