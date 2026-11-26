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

TEST_CASE("string::chrapi") {
    SECTION("Utf8") {
        SECTION("Utf8eql") {
            REQUIRE(Utf8eql("Do you equal me", "Do you equal me"));
            REQUIRE(Utf8ieql("Do you equal me", "Do you equal me"));

            REQUIRE(!Utf8eql("Do you equal me", "do you equal me"));
            REQUIRE(Utf8ieql("Do you equal me", "do you equal me"));
        }
        SECTION("Utf8ieql") {
            REQUIRE(Utf8ieql("Do you equal me", "Do you equal me"));
            REQUIRE(Utf8ieql("Do you equal me", "do you equal me"));
        }
        SECTION("Utf8cpy includes final null") {
            std::array<char, 5> chars;
            std::fill(chars.begin(), chars.end(), 'A');
            Utf8cpy(&chars.front(), 3, "Hi");
            REQUIRE(chars[0] == 'H');
            REQUIRE(chars[1] == 'i');
            REQUIRE(chars[2] == '\0');
        }
        SECTION("strncpy includes final null (Reference)") {
            std::array<char, 5> chars;
            std::fill(chars.begin(), chars.end(), 'A');
            strncpy(&chars.front(), "Hi", 3);
            REQUIRE(chars[0] == 'H');
            REQUIRE(chars[1] == 'i');
            REQUIRE(chars[2] == '\0');
        }
        SECTION("Utf8cpy does not go beyond the buffer") {
            std::array<char, 5> chars;
            std::fill(chars.begin(), chars.end(), 'A');
            Utf8cpy(&chars.front(), 10, "Hi");
            REQUIRE(chars[0] == 'H');
            REQUIRE(chars[1] == 'i');
            REQUIRE(chars[2] == '\0');
            REQUIRE(chars[3] == 'A');
        }
        SECTION(
            "strncpy - This fails since strncpy keeps writing no matter "
            "what!") {
#if 0
			std::array<char, 5> chars;
			std::fill(chars.begin(), chars.end(), 'A');
			strncpy(&chars.front(), "Hi", 10);
			REQUIRE(chars[0] == 'H');
			REQUIRE(chars[1] == 'i');
			REQUIRE(chars[2] == '\0');
			REQUIRE(chars[3] == 'A');
#endif
        }
        SECTION("Utf8len") {
            std::array<char, 5> chars = {};
            std::fill(chars.begin(), chars.end() - 1, 'A');
            REQUIRE(Utf8len(&chars.front()) == 4);
        }
        SECTION("strlen (reference)") {
            std::array<char, 5> chars = {};
            std::fill(chars.begin(), chars.end() - 1, 'A');
            REQUIRE(strlen(&chars.front()) == 4);
        }
        SECTION("Utf8cmp") {
            REQUIRE(Utf8cmp("Hi", "Hi") == 0);
            REQUIRE(Utf8cmp("HI", "Hi") < 0);
            REQUIRE(Utf8cmp("Hi", "HI") > 0);
            REQUIRE(Utf8cmp("Hi", "Hi") == 0);
            REQUIRE(Utf8cmp("HI", "Hi") < 0);
        }
        SECTION("strcmp (reference)") {
            REQUIRE(strcmp("Hi", "Hi") == 0);
            REQUIRE(strcmp("HI", "Hi") < 0);
            REQUIRE(strcmp("Hi", "HI") > 0);
            REQUIRE(strcmp("Hi", "Hi") == 0);
            REQUIRE(strcmp("HI", "Hi") < 0);
        }
        SECTION("Utf8icmp") {
            REQUIRE(Utf8icmp("Hi", "Hi") == 0);
            REQUIRE(Utf8icmp("HI", "Hi") == 0);
            REQUIRE(Utf8icmp("Hi", "HI") == 0);
            REQUIRE(Utf8icmp("Hii", "Hi") > 0);
            REQUIRE(Utf8icmp("HIi", "Hi") > 0);
            REQUIRE(Utf8icmp("Hi", "HIii") < 0);
            REQUIRE(Utf8icmp("Hi", "Hiii") < 0);
            REQUIRE(Utf8icmp("HI", "Hiii") < 0);
            REQUIRE(Utf8icmp("Hi", "HIii") < 0);
        }
#if ROCKETRIDE_PLAT_WIN
        SECTION("stricmp (reference0") {
            REQUIRE(stricmp("Hi", "Hi") == 0);
            REQUIRE(stricmp("HI", "Hi") == 0);
            REQUIRE(stricmp("Hi", "HI") == 0);
            REQUIRE(stricmp("Hii", "Hi") > 0);
            REQUIRE(stricmp("HIi", "Hi") > 0);
            REQUIRE(stricmp("Hi", "HIii") < 0);
            REQUIRE(stricmp("Hi", "Hiii") < 0);
            REQUIRE(stricmp("HI", "Hiii") < 0);
            REQUIRE(stricmp("Hi", "HIii") < 0);
        }
#endif
        SECTION("Utf8ncmp") {
            REQUIRE(Utf8ncmp("Hi", "Hi", 2) == 0);
            REQUIRE(Utf8ncmp("Hiaaa", "Hi", 2) == 0);
            REQUIRE(Utf8ncmp("Hiaaa", "Hiaaa", 2) == 0);
            REQUIRE(Utf8ncmp("HIaaa", "Hiaaa", 2) < 0);
            REQUIRE(Utf8ncmp("Hiaaa", "HIaaa", 2) > 0);
        }
        SECTION("strncmp (reference)") {
            REQUIRE(strncmp("Hi", "Hi", 2) == 0);
            REQUIRE(strncmp("Hiaaa", "Hi", 2) == 0);
            REQUIRE(strncmp("Hiaaa", "Hiaaa", 2) == 0);
            REQUIRE(strncmp("HIaaa", "Hiaaa", 2) < 0);
            REQUIRE(strncmp("Hiaaa", "HIaaa", 2) > 0);
        }
        SECTION("Utf8cpy") {
            std::array<char, 10> chars = {};
            Utf8cpy(&chars.front(), 1, "ABCD");
            REQUIRE(chars[0] == 'A');
            REQUIRE(chars[1] == '\0');
            REQUIRE(chars[2] == '\0');

            Utf8cpy(&chars.front(), 2, "ABCD");
            REQUIRE(chars[0] == 'A');
            REQUIRE(chars[1] == 'B');
            REQUIRE(chars[2] == '\0');

            Utf8cpy(&chars.front(), 3, "ABCD");
            REQUIRE(chars[0] == 'A');
            REQUIRE(chars[1] == 'B');
            REQUIRE(chars[2] == 'C');
            REQUIRE(chars[3] == '\0');

            Utf8cpy(&chars.front(), 4, "ABCD");
            REQUIRE(chars[0] == 'A');
            REQUIRE(chars[1] == 'B');
            REQUIRE(chars[2] == 'C');
            REQUIRE(chars[3] == 'D');
            REQUIRE(chars[4] == '\0');

            Utf8cpy(&chars.front(), 5, "ABCD");
            REQUIRE(chars[0] == 'A');
            REQUIRE(chars[1] == 'B');
            REQUIRE(chars[2] == 'C');
            REQUIRE(chars[3] == 'D');
            REQUIRE(chars[4] == '\0');
        }
        SECTION("strncpy (reference)") {
            std::array<char, 10> chars = {};
            strncpy(&chars.front(), "ABCD", 1);
            REQUIRE(chars[0] == 'A');
            REQUIRE(chars[1] == '\0');
            REQUIRE(chars[2] == '\0');

            strncpy(&chars.front(), "ABCD", 2);
            REQUIRE(chars[0] == 'A');
            REQUIRE(chars[1] == 'B');
            REQUIRE(chars[2] == '\0');

            strncpy(&chars.front(), "ABCD", 3);
            REQUIRE(chars[0] == 'A');
            REQUIRE(chars[1] == 'B');
            REQUIRE(chars[2] == 'C');
            REQUIRE(chars[3] == '\0');

            strncpy(&chars.front(), "ABCD", 4);
            REQUIRE(chars[0] == 'A');
            REQUIRE(chars[1] == 'B');
            REQUIRE(chars[2] == 'C');
            REQUIRE(chars[3] == 'D');
            REQUIRE(chars[4] == '\0');

            strncpy(&chars.front(), "ABCD", 5);
            REQUIRE(chars[0] == 'A');
            REQUIRE(chars[1] == 'B');
            REQUIRE(chars[2] == 'C');
            REQUIRE(chars[3] == 'D');
            REQUIRE(chars[4] == '\0');
        }
        SECTION("Utf8chr") {
            auto str = "ABCD";
            REQUIRE(Utf8chr(str, 'A') == str);
        }
        SECTION("strchr (reference)") {
            auto str = "ABCD";
            REQUIRE(strchr(str, 'A') == str);
        }
        SECTION("Utf8cat") {
            std::array<char, 20> charsDest = {};

            Utf8cat(&charsDest.front(), "H");
            Utf8cat(&charsDest.front(), "A");
            Utf8cat(&charsDest.front(), "P");
            Utf8cat(&charsDest.front(), "P");
            Utf8cat(&charsDest.front(), "P");
            REQUIRE(charsDest[0] == 'H');
            REQUIRE(charsDest[1] == 'A');
            REQUIRE(charsDest[2] == 'P');
            REQUIRE(charsDest[3] == 'P');
            REQUIRE(charsDest[4] == 'P');
            REQUIRE(charsDest[5] == '\0');
        }
        SECTION("strcat (reference)") {
            std::array<char, 20> charsDest = {};

            strcat(&charsDest.front(), "H");
            strcat(&charsDest.front(), "A");
            strcat(&charsDest.front(), "P");
            strcat(&charsDest.front(), "P");
            strcat(&charsDest.front(), "P");
            REQUIRE(charsDest[0] == 'H');
            REQUIRE(charsDest[1] == 'A');
            REQUIRE(charsDest[2] == 'P');
            REQUIRE(charsDest[3] == 'P');
            REQUIRE(charsDest[4] == 'P');
            REQUIRE(charsDest[5] == '\0');
        }
    }
}
