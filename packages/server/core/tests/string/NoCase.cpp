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

// Verify that equality is case-insensitive whether the iText or iTextView
// occurs on the left-hand or right-hand side
TEST_CASE("Case-insensitive equality") {
    SECTION("TextView") {
        REQUIRE_FALSE(TextView("cat") == TextView("CAT"));
        REQUIRE_FALSE(TextView("cat") == Text("CAT"));
        REQUIRE(TextView("cat") == iTextView("CAT"));
        REQUIRE(TextView("cat") == iText("CAT"));
    }

    SECTION("Text") {
        REQUIRE_FALSE(Text("cat") == Text("CAT"));
        REQUIRE_FALSE(Text("cat") == TextView("CAT"));
        REQUIRE(Text("cat") == iTextView("CAT"));
        REQUIRE(Text("cat") == iText("CAT"));
    }

    SECTION("iTextView") {
        REQUIRE(iTextView("cat") == TextView("CAT"));
        REQUIRE(iTextView("cat") == Text("CAT"));
        REQUIRE(iTextView("cat") == iTextView("CAT"));
        REQUIRE(iTextView("cat") == iText("CAT"));
    }

    SECTION("iText") {
        REQUIRE(iText("cat") == TextView("CAT"));
        REQUIRE(iText("cat") == Text("CAT"));
        REQUIRE(iText("cat") == iTextView("CAT"));
        REQUIRE(iText("cat") == iText("CAT"));
    }
}

// Verify that inequality is case-insensitive whether the iText or iTextView
// occurs on the left-hand or right-hand side
TEST_CASE("Case-insensitive inequality") {
    SECTION("TextView") {
        REQUIRE(TextView("cat") != TextView("CAT"));
        REQUIRE(TextView("cat") != Text("CAT"));
        REQUIRE_FALSE(TextView("cat") != iTextView("CAT"));
        REQUIRE_FALSE(TextView("cat") != iText("CAT"));
    }

    SECTION("Text") {
        REQUIRE(Text("cat") != Text("CAT"));
        REQUIRE(Text("cat") != TextView("CAT"));
        REQUIRE_FALSE(Text("cat") != iTextView("CAT"));
        REQUIRE_FALSE(Text("cat") != iText("CAT"));
    }

    SECTION("iTextView") {
        REQUIRE_FALSE(iTextView("cat") != TextView("CAT"));
        REQUIRE_FALSE(iTextView("cat") != Text("CAT"));
        REQUIRE_FALSE(iTextView("cat") != iTextView("CAT"));
        REQUIRE_FALSE(iTextView("cat") != iText("CAT"));
    }

    SECTION("iText") {
        REQUIRE_FALSE(iText("cat") != TextView("CAT"));
        REQUIRE_FALSE(iText("cat") != Text("CAT"));
        REQUIRE_FALSE(iText("cat") != iTextView("CAT"));
        REQUIRE_FALSE(iText("cat") != iText("CAT"));
    }
}
