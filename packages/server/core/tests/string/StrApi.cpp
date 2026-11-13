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

TEST_CASE("string::api") {
    SECTION("Case") {
        using api = string::StrApi<char, std::char_traits<char>,
                                   std::allocator<char>, string::Case<char>>;

        SECTION("toLower") {
            REQUIRE(api::toLower("JOHN") == "john");
            REQUIRE(api::toLower("john") == "john");
            REQUIRE(api::toLower("") == "");
        }

        SECTION("toUpper") {
            REQUIRE(api::toUpper("JOHN") == "JOHN");
            REQUIRE(api::toUpper("john") == "JOHN");
            REQUIRE(api::toUpper("") == "");
        }

        SECTION("extractEnclosed") {
            REQUIRE(api::extractEnclosed("\"JOHN\"", '"') == "JOHN");
            REQUIRE(api::extractEnclosed("JOHN\"", '"') == "JOHN\"");
            REQUIRE(api::extractEnclosed("\"JO\"HN\"", '"') == "JO\"HN");
            REQUIRE(api::extractEnclosed("[JO]hn", '[', ']') == "JO");
            REQUIRE(api::extractEnclosed("[JO]hn", ']', '[') == "[JO]hn");
            REQUIRE(api::extractEnclosed("", ']') == "");
        }

        SECTION("trimLeading") {
            REQUIRE(api::trimLeading(" \t\n   JOHN") == "JOHN");
            REQUIRE(api::trimLeading("\"JOHN\"", {'\"'}) == "JOHN\"");
            REQUIRE(api::trimLeading("\"JOHN\"", {'\"', 'J'}) == "OHN\"");
            REQUIRE(api::trimLeading("\"JOHN\"", {}) == "\"JOHN\"");
            REQUIRE(api::trimLeading("", {}) == "");
        }

        SECTION("trimTrailing") {
            REQUIRE(api::trimTrailing("JOHN \t\n   ") == "JOHN");
            REQUIRE(api::trimTrailing("\"JOHN\"", {'\"'}) == "\"JOHN");
            REQUIRE(api::trimTrailing("\"JOHN\"", {'\"', 'N'}) == "\"JOH");
            REQUIRE(api::trimTrailing("\"JOHN\"", {}) == "\"JOHN\"");
            REQUIRE(api::trimTrailing("", {}) == "");
        }

        SECTION("trim") {
            REQUIRE(api::trim("\t\n   JOHN \t\n   ") == "JOHN");
            REQUIRE(api::trim("\"JOHN\"", {'\"'}) == "JOHN");
            REQUIRE(api::trim("\"JOHN\"", {'\"', 'N'}) == "JOH");
            REQUIRE(api::trim("\"JOHN\"", {}) == "\"JOHN\"");
            REQUIRE(api::trim("", {}) == "");
        }

        SECTION("startsWith") {
            REQUIRE(api::startsWith("\t\n   JOHN \t\n   ", "\t\n"));
            REQUIRE(api::startsWith("yolo", "y"));
            REQUIRE(api::startsWith("yolo", "yo"));
            REQUIRE(api::startsWith("yolo", "yol"));
            REQUIRE(api::startsWith("yolo", "yolo"));
            REQUIRE(!api::startsWith("yolo", "YoLo"));
            REQUIRE(!api::startsWith("yolo", "yoloy"));
            REQUIRE(!api::startsWith("", "yoloy"));
            REQUIRE(!api::startsWith("", ""));
        }

        SECTION("endsWith") {
            REQUIRE(!api::endsWith("\t\n   JOHN \t\n   ", "\t\n"));
            REQUIRE(api::endsWith("\t\n   JOHN \t\n   ", " "));
            REQUIRE(api::endsWith("yolo", "yolo"));
            REQUIRE(api::endsWith("yolo", "olo"));
            REQUIRE(api::endsWith("yolo", "lo"));
            REQUIRE(api::endsWith("yolo", "o"));
            REQUIRE(!api::endsWith("yolo", "O"));
            REQUIRE(!api::endsWith("yolo", "yoloy"));
            REQUIRE(!api::endsWith("yolo", "Yoloy"));
            REQUIRE(!api::endsWith("", "yoloy"));
            REQUIRE(!api::endsWith("", ""));
        }

        SECTION("remove") {
            REQUIRE(api::remove<Text>("john smith", std::allocator<char>{}, "J",
                                      "o", "h", "N") == "jn smit");
            REQUIRE(api::remove<Text>("john smith", std::allocator<char>{},
                                      "") == "john smith");
        }

        SECTION("replace") {
            REQUIRE(api::replace("John Smith", "john", "smith") ==
                    "John Smith");
            REQUIRE(api::replace("John Smith", "j", "jjjjjj") == "John Smith");
            REQUIRE(api::replace("John Smith", "invalid", "bobo") ==
                    "John Smith");

            REQUIRE(api::replace("John Smith", "John", "smith") ==
                    "smith Smith");
            REQUIRE(api::replace("John Smith", "h", "a") == "Joan Smita");
            REQUIRE(api::replace("John Smith", "h", "JOHN SMITH WAS HERE") ==
                    "JoJOHN SMITH WAS HEREn SmitJOHN SMITH WAS HERE");
            REQUIRE(api::replace("", "h", "a") == "");
            REQUIRE(api::replace("", "", "") == "");
        }

        SECTION("contains") {
            REQUIRE(!api::contains("C:/test1/test2/file5.txt", "folder1"));
            REQUIRE(!api::contains("C:/test1/test2/file5.txt", "Test1"));
            REQUIRE(api::contains("C:/test1/test2/file5.txt", "test1"));
        }
    }

    SECTION("NoCase") {
        using api = string::StrApi<char, std::char_traits<char>,
                                   std::allocator<char>, string::NoCase<char>>;

        SECTION("toLower") {
            REQUIRE(api::toLower("JOHN") == "john");
            REQUIRE(api::toLower("john") == "john");
            REQUIRE(api::toLower("") == "");
        }

        SECTION("toUpper") {
            REQUIRE(api::toUpper("JOHN") == "JOHN");
            REQUIRE(api::toUpper("john") == "JOHN");
            REQUIRE(api::toUpper("") == "");
        }

        SECTION("extractEnclosed") {
            REQUIRE(api::extractEnclosed("\"JOHN\"", '"') == "JOHN");
            REQUIRE(api::extractEnclosed("JOHN\"", '"') == "JOHN\"");
            REQUIRE(api::extractEnclosed("\"JO\"HN\"", '"') == "JO\"HN");
            REQUIRE(api::extractEnclosed("[JO]hn", '[', ']') == "JO");
            REQUIRE(api::extractEnclosed("[JO]hn", ']', '[') == "[JO]hn");
            REQUIRE(api::extractEnclosed("", ']') == "");
        }

        SECTION("trimLeading") {
            REQUIRE(api::trimLeading(" \t\n   JOHN") == "JOHN");
            REQUIRE(api::trimLeading("\"JOHN\"", {'\"'}) == "JOHN\"");
            REQUIRE(api::trimLeading("\"JOHN\"", {'\"', 'j'}) == "OHN\"");
            REQUIRE(api::trimLeading("\"JOHN\"", {}) == "\"JOHN\"");
            REQUIRE(api::trimLeading("", {}) == "");
        }

        SECTION("trimTrailing") {
            REQUIRE(api::trimTrailing("JOHN \t\n   ") == "JOHN");
            REQUIRE(api::trimTrailing("\"JOHN\"", {'\"'}) == "\"JOHN");
            REQUIRE(api::trimTrailing("\"JOHN\"", {'\"', 'n'}) == "\"JOH");
            REQUIRE(api::trimTrailing("\"JOHN\"", {}) == "\"JOHN\"");
            REQUIRE(api::trimTrailing("", {}) == "");
        }

        SECTION("trim") {
            REQUIRE(api::trim("\t\n   JOHN \t\n   ") == "JOHN");
            REQUIRE(api::trim("\"JOHN\"", {'\"'}) == "JOHN");
            REQUIRE(api::trim("\"JOHN\"", {'\"', 'n'}) == "JOH");
            REQUIRE(api::trim("\"JOHN\"", {}) == "\"JOHN\"");
            REQUIRE(api::trim("", {}) == "");
        }

        SECTION("startsWith") {
            REQUIRE(api::startsWith("\t\n   JOHN \t\n   ", "\t\n"));
            REQUIRE(api::startsWith("yolo", "y"));
            REQUIRE(api::startsWith("yolo", "yo"));
            REQUIRE(api::startsWith("yolo", "yol"));
            REQUIRE(api::startsWith("yolo", "yolo"));
            REQUIRE(api::startsWith("yolo", "YoLo"));
            REQUIRE(!api::startsWith("yolo", "yoloy"));
            REQUIRE(!api::startsWith("", "yoloy"));
            REQUIRE(!api::startsWith("", ""));
        }

        SECTION("endsWith") {
            REQUIRE(!api::endsWith("\t\n   JOHN \t\n   ", "\t\n"));
            REQUIRE(api::endsWith("\t\n   JOHN \t\n   ", " "));
            REQUIRE(api::endsWith("yolo", "yolo"));
            REQUIRE(api::endsWith("yolo", "olo"));
            REQUIRE(api::endsWith("yolo", "lo"));
            REQUIRE(api::endsWith("yolo", "o"));
            REQUIRE(api::endsWith("yolo", "O"));
            REQUIRE(!api::endsWith("yolo", "yoloy"));
            REQUIRE(!api::endsWith("yolo", "Yoloy"));
            REQUIRE(!api::endsWith("", "yoloy"));
            REQUIRE(!api::endsWith("", ""));
        }

        SECTION("remove") {
            REQUIRE(api::remove<Text>("john smith", std::allocator<char>{}, "J",
                                      "o", "h", "N") == " smit");
            REQUIRE(api::remove<Text>("john smith", std::allocator<char>{},
                                      "") == "john smith");
        }

        SECTION("replace") {
            REQUIRE(api::replace("John Smith", "john", "smith") ==
                    "smith Smith");
            REQUIRE(api::replace("John Smith", "j", "jjjjjj") ==
                    "jjjjjjohn Smith");
            REQUIRE(api::replace("John Smith", "invalid", "bobo") ==
                    "John Smith");
            REQUIRE(api::replace("John Smith", "S", "JOHN SMITH WAS HERE") ==
                    "John JOHN SMITH WAS HEREmith");
            REQUIRE(
                api::replace("jjjjjjjjj", "j", "JOHN SMITH WAS HERE") ==
                "JOHN SMITH WAS HEREJOHN SMITH WAS HEREJOHN SMITH WAS HEREJOHN "
                "SMITH WAS HEREJOHN SMITH WAS HEREJOHN SMITH WAS HEREJOHN "
                "SMITH WAS HEREJOHN SMITH WAS HEREJOHN SMITH WAS HERE");
            REQUIRE(api::replace("", "", "") == "");
        }

        SECTION("contains") {
            REQUIRE(!api::contains("C:/test1/test2/file5.txt", "folder1"));
            REQUIRE(api::contains("C:/test1/test2/file5.txt", "Test1"));
            REQUIRE(api::contains("C:/test1/test2/file5.txt", "test1"));
        }
    }

    SECTION("Immutable api") {
        SECTION("find") {
            REQUIRE(string::find("john*smith", "*") == 4);
            REQUIRE(string::find("john*smith", "bobo") == string::npos);
            REQUIRE(string::find("johnBoBOsmith", "bobo") == string::npos);
            REQUIRE(string::find("johnBoBOsmith", "bobo", false) == 4);
        }

        SECTION("slice") {
            REQUIRE(string::slice("john*smith", "*") ==
                    Pair<Text, Text>{"john", "smith"});
            REQUIRE(string::slice("johnBoBosmith", "BoBo") ==
                    Pair<Text, Text>{"john", "smith"});
            REQUIRE(string::slice("johnBoBosmith", "bobo") ==
                    Pair<Text, Text>{"johnBoBosmith", {}});
            REQUIRE(string::slice("johnBoBosmith", "bobo", false) ==
                    Pair<Text, Text>{"john", "smith"});
        }

        SECTION("removeLeading") {
            REQUIRE(string::removeLeading("john*smith", "*") == "john*smith");
            REQUIRE(string::removeLeading("john*smith", "ohn") == "john*smith");
            REQUIRE(string::removeLeading("john*smith", "John") ==
                    "john*smith");
            REQUIRE(string::removeLeading("john*smith", "John", false) ==
                    "*smith");
        }

        SECTION("removeTrailing") {
            REQUIRE(string::removeTrailing("john*smith", "*") == "john*smith");
            REQUIRE(string::removeTrailing("john*smith", "mith") == "john*s");
            REQUIRE(string::removeTrailing("john*smIth", "mith") ==
                    "john*smIth");
            REQUIRE(string::removeTrailing("john*smIth", "mith", false) ==
                    "john*s");
        }
    }

    SECTION("Character type tests") {
        for (char ch = 0; ch < MaxValue<char>; ++ch) {
            REQUIRE(string::isAscii(ch) == isascii(ch));
            REQUIRE(string::isSpace(ch) == _cast<bool>(std::isspace(ch)));
            REQUIRE(string::isNumeric(ch, false) ==
                    _cast<bool>(std::isdigit(ch)));
            REQUIRE(string::isNumeric(ch, true) ==
                    _cast<bool>(std::isxdigit(ch)));
        }
    }

    SECTION("isSpace (Unicode)") {
        REQUIRE_FALSE(string::isSpace(
            _cast<char>(0xA0)));  // Accented lower-case a in extended ASCII
        REQUIRE(string::isSpace(0x00A0));        // Non-breaking space (UTF-16)
        REQUIRE(string::isSpace(0x000000A0));    // Non-breaking space (UTF-32)
        REQUIRE_FALSE(string::isSpace(0x00AE));  // Registered trademark symbol
    }

    SECTION("isVerticalSpace") {
        REQUIRE(string::isVerticalSpace('\n'));
        REQUIRE(string::isVerticalSpace('\r'));
        REQUIRE_FALSE(string::isVerticalSpace(' '));
        REQUIRE_FALSE(string::isVerticalSpace('\t'));
    }

    SECTION("isHorizontalSpace") {
        REQUIRE_FALSE(string::isHorizontalSpace('\n'));
        REQUIRE_FALSE(string::isHorizontalSpace('\r'));
        REQUIRE(string::isHorizontalSpace(' '));
        REQUIRE(string::isHorizontalSpace('\t'));
    }

    SECTION("isNumeric") {
        REQUIRE(string::isNumeric("12345"_tv));

        // Negative numbers
        REQUIRE(string::isNumeric("-12345"_tv));
        REQUIRE_FALSE(string::isNumeric("123-45"_tv));
        REQUIRE_FALSE(string::isNumeric("-"_tv));

        // Floating point numbers
        REQUIRE(string::isNumeric("123.45"_tv));
        REQUIRE(string::isNumeric("12345."_tv));
        REQUIRE(string::isNumeric(".12345"_tv));
        REQUIRE_FALSE(string::isNumeric("123.4.5"_tv));
    }

    SECTION("isHex") {
        REQUIRE(string::isHex("abcd"_tv));
        REQUIRE_FALSE(string::isHex("xyx"_tv));

        // Hex prefix
        REQUIRE(string::isHex("0xabcd"_tv));
        REQUIRE_FALSE(string::isHex("0x"_tv));
        REQUIRE_FALSE(string::isHex("abcd0x"_tv));

        // Negative numbers
        REQUIRE(string::isHex("-abcd"_tv));
        REQUIRE(string::isHex("-0xabcd"_tv));
        REQUIRE_FALSE(string::isHex("ab-cd"_tv));
        REQUIRE(string::isHex("abcd.abcd"_tv));
        REQUIRE(string::isHex(".abcd"_tv));
        REQUIRE_FALSE(string::isHex("ab.c.d"_tv));
    }

    SECTION("Character type tests with non-character data") {
        _using(char ch) {
            ch = ' ';
            REQUIRE(string::isSpace(ch));
        }

        _using(Text str) {
            // Whitespace
            str = " \r\n";
            REQUIRE(string::isAscii(str));
            REQUIRE(string::isSpace(str));
            REQUIRE_FALSE(string::isNumeric(str));
            REQUIRE_FALSE(string::isSymbol(str));

            // Normal text
            str = "a b";
            REQUIRE(string::isAscii(str));
            REQUIRE_FALSE(string::isSpace(str));
            REQUIRE_FALSE(string::isNumeric(str));
            REQUIRE_FALSE(string::isSymbol(str));

            // Numeric text (decimal)
            str = "1234";
            REQUIRE(string::isAscii(str));
            REQUIRE_FALSE(string::isSpace(str));
            REQUIRE(string::isNumeric(str));
            REQUIRE_FALSE(string::isSymbol(str));

            // Numeric text (hex)
            str = "ffff";
            REQUIRE(string::isAscii(str));
            REQUIRE_FALSE(string::isSpace(str));
            REQUIRE_FALSE(string::isNumeric(str));
            REQUIRE(string::isNumeric(str, true));
            REQUIRE_FALSE(string::isSymbol(str));

            // Symbols
            str = "&$#";
            REQUIRE(string::isAscii(str));
            REQUIRE_FALSE(string::isSpace(str));
            REQUIRE_FALSE(string::isNumeric(str));
            REQUIRE(string::isSymbol(str));

            // Horizontal whitespace
            str = " \t";
            REQUIRE(string::isHorizontalSpace(str));
            REQUIRE_FALSE(string::isVerticalSpace(str));

            // Vertical whitespace
            str = "\r\n";
            REQUIRE(string::isVerticalSpace(str));
            REQUIRE_FALSE(string::isHorizontalSpace(str));
        }

        _using(TextView tv) {
            tv = " \r\n";
            REQUIRE(string::isSpace(tv));

            tv = "a b";
            REQUIRE_FALSE(string::isSpace(tv));
        }

        _using(std::vector<char> v) {
            v = {' ', '\n', '\r'};
            REQUIRE(string::isSpace(v));
            v = {' ', 'a', 'b'};
            REQUIRE_FALSE(string::isSpace(v));
        }
    }
}
