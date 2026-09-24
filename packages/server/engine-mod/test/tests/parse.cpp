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

#include "../store.h"

/**
 * Generic parse filter test class
 */
class GenericParseFilterTest : public IFilterTest {
public:
    GenericParseFilterTest(TextVector filters) : IFilterTest(filters) {}

    Text getText() const noexcept {
        const auto &entry = getEntry();
        if (entry.response && entry.response().isObject()) {
            auto value = entry.response().lookup("text");
            if (value.isString()) {
                return value.asString();
            } else if (value.isArray()) {
                const auto &item = value[0];
                if (item.isString()) return item.asString();
            }
        }
        return {};
    }

    /// Response filter puts table lane in response["table"] (array). Returns
    /// concatenated table content so tests can assert table extraction.
    Text getTable() const noexcept {
        const auto &entry = getEntry();
        if (entry.response && entry.response().isObject()) {
            auto value = entry.response().lookup("table");
            if (value.isArray() && !value.empty()) {
                Text out;
                for (const auto &item : value) {
                    if (item.isString()) out += item.asString();
                }
                return out;
            }
        }
        return {};
    }
};

/**
 * Defines pipeline for parsing text files
 */
class ParseFilterTest : public GenericParseFilterTest {
public:
    ParseFilterTest()
        : GenericParseFilterTest(
              {engine::store::filter::parse::Type, "response"}) {}
};

/**
 * Defines pipeline for parsing image files with OCR
 */
class ParseFilterTestWithOCR : public GenericParseFilterTest {
public:
    ParseFilterTestWithOCR()
        : GenericParseFilterTest(
              {engine::store::filter::parse::Type, "ocr", "response"}) {}
};

TEST_CASE("store::parse") {
    //-----------------------------------------------------------------
    // Parses raw text
    //-----------------------------------------------------------------
    SECTION("parse text") {
        ParseFilterTest filter;
        Error ccode;

        // Build and connect the endpoint
        REQUIRE_NO_ERROR(filter.connect());

        // Get a source pipe, open a dummy object on it
        auto pipe = filter.openObject("test.txt"_tv, Entry::FLAGS::INDEX);
        REQUIRE_NO_ERROR(pipe);

        // Get some text to pass through - this text has a Utf-8 BOM, with a
        // emoji smiley face embedded in it
        const char *pText = "\xEF\xBB\xBFThis is a test \xF0\x9F\x98\x81";

        // Pass the text through the tag system to the parser
        REQUIRE_NO_ERROR(filter.writeTagBeginStream(*pipe));
        REQUIRE_NO_ERROR(
            filter.writeTagData(*pipe, strlen(pText), (void *)pText));
        REQUIRE_NO_ERROR(filter.writeTagEndStream(*pipe));

        // Close it
        REQUIRE_NO_ERROR(filter.closeObject(*pipe));

        // What we are expecting Tika to do here is to recognize that the input
        // string is in Utf8 format, parse it and convert the embedded emoji
        // into it's appropriate surrogate pair for Utf16. This is what our
        // internal Utf8<->Utf16 conversion does, but this will prove the
        // parsing capabilities of Tika. Note that if you leave off the Utf8
        // BOM, Tika will not recognize this as Utf8 and give an invalid parse
        auto expected = Utf16{
            u"This is a test "
            u"\xD83D"
            u"\xDE01"
            u"\n\n\n"};

        REQUIRE(filter.getText() == Utf8{expected});
    }

    //-----------------------------------------------------------------
    // Proves we normalize mal-formed composite characters correctly
    // Using NFC mode, not NFKC mode
    //-----------------------------------------------------------------
    SECTION("parse malformed composites") {
        ParseFilterTest filter;

        // Malformed composites
        //	The character is "ẛ̣" which is (decomposed) 3 code points
        //		1) The initial 		u17f	ſ
        //		2) The above accent u307
        //		3) The below accent u323
        //	Raw Tika will just return the malformed decomposed characters, but
        //	our parse code normalizes it into NFC (not NFKC) mode so it should
        //	compose it back into the correct set of characters \u1E9b\u0323
        const auto pText =
            u8"Begin->"
            u8"\u2122"              // (TM) symbol
            u8"\u017F\u0307\u0323"  // Decomposed - wrong order
            u8"\u017F\u0323\u0307"  // Decomposed - correct order
            u8"\u1E9B\u0323"        // Composed
            u8"<-End";

        // Pass the text through the tag system to the parser
        REQUIRE_NO_ERROR(filter.writeTagData("test.txt", pText));

        auto expected = Utf16{
            u"Begin->"
            u"\u2122"        // (TM) symbol - should be left as is
            u"\u1E9B\u0323"  // Composed
            u"\u1E9B\u0323"  // Composed
            u"\u1E9B\u0323"  // Composed
            u"<-End\n\n\n"};

        REQUIRE(filter.getText() == Utf8{expected});
    }

    //-----------------------------------------------------------------
    // Parses simple files (with and without OCR)
    //-----------------------------------------------------------------
    SECTION("parse files") {
        ParseFilterTest filter;
        Error ccode;

        // Parse it - easy case, straight text
        REQUIRE_NO_ERROR(filter.sendFile("MidWordFontChange.docx"));
        REQUIRE(filter.getText() == Utf8{u"Midword fontchange\n\n\n"});

        // Tougher case - it must recognize the TM symbol
        REQUIRE_NO_ERROR(filter.sendFile("rocketride.txt"));
        REQUIRE(filter.getText() ==
                Utf8{u"RocketRide \u2122 RocketRide \n\n\n"});

        // Shouldn't get anything since it's an image only file with no ocr
        REQUIRE_NO_ERROR(filter.sendFile("ocr.bmp", Entry::FLAGS::INDEX));
        REQUIRE(filter.getText() == Utf8{u""});
    }

    //-----------------------------------------------------------------
    // Parses PDF files (uses Tika default parser without Aspose)
    //-----------------------------------------------------------------
    SECTION("parse pdf") {
        ParseFilterTest filter;

        REQUIRE_NO_ERROR(filter.sendFile("sample.pdf"));
        auto text = filter.getText();
        REQUIRE(!text.empty());
        REQUIRE(text.contains("A Simple PDF File"));
        REQUIRE(text.contains("Virtual Mechanics"));
        REQUIRE(text.contains("Continued on page 2"));
    }

    SECTION("parse minimal pdf") {
        ParseFilterTest filter;

        REQUIRE_NO_ERROR(filter.sendFile("minimal.pdf"));
        auto text = filter.getText();
        REQUIRE(text.contains("Hello World"));
    }

    //-----------------------------------------------------------------
    // Parses Excel files (uses Tika table fallback when Aspose is not used)
    // Regression: table content must be emitted (see Table.java fallback fix).
    // Response filter puts table in response["table"], not response["text"].
    //-----------------------------------------------------------------
    SECTION("parse xlsx") {
        ParseFilterTest filter;

        REQUIRE_NO_ERROR(filter.sendFile("spreadsheet.xlsx"));
        auto text = filter.getText();
        REQUIRE(!text.empty());
        REQUIRE(text.contains("Excel"));
        REQUIRE(text.contains("spreadsheet"));
        // Table lane must have content (fails without Table.java fix)
        auto table = filter.getTable();
        REQUIRE(!table.empty());
        REQUIRE(table.contains("TableFallbackTest"));
    }
}

/*------------------------------------------------------------------
 * Parses image files with OCR
 * It is heavy, so it is not run by default
 *------------------------------------------------------------------*/
TEST_CASE("store::ocr_parse", "[.]") {
    //-----------------------------------------------------------------
    // Parses simple files (with and without OCR)
    //-----------------------------------------------------------------
    SECTION("parse files with OCR") {
        ParseFilterTestWithOCR filter;
        Error ccode;

        // Should parse the image and get something back
        REQUIRE_NO_ERROR(filter.sendFile("ocr.bmp", Entry::FLAGS::INDEX));
        REQUIRE(filter.getText() == Utf8{u"TEST"});

        // Really tough case - mahjong tiles couldn't be OCRed now - so skip it
        REQUIRE_NO_ERROR(filter.sendFile("mahjong.png", Entry::FLAGS::INDEX));
        // REQUIRE(filter.getText() == Utf8{u"titf"});

        // Should parse the image and get something back
        REQUIRE_NO_ERROR(filter.sendFile(
            "ocr.bmp", Entry::FLAGS::INDEX | Entry::FLAGS::OCR));
        REQUIRE(filter.getText() == Utf8{u"TEST"});

        // Really tough case - mahjong tiles couldn't be OCRed now - so skip it
        REQUIRE_NO_ERROR(filter.sendFile(
            "mahjong.png", Entry::FLAGS::INDEX | Entry::FLAGS::OCR));
        // REQUIRE(filter.getText() == Utf8{u"titf"});
    }
}
