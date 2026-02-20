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

// Coverage for the Str class in apLib
TEST_CASE("string::Str") {
    SECTION("Text") {
        SECTION("Implicit cast") {
            Text test = "test";
            REQUIRE(!Txtcmp(test, "test"));
            REQUIRE(test);
        }

        SECTION("Move assign") {
            Text test = "Hi";
            Text test2 = std::move(test);
            REQUIRE(test2 == "Hi");
            REQUIRE(test == "");
            auto test3 = std::move(test2);
            REQUIRE(test == "");
            REQUIRE(test3 == "Hi");
        }

        SECTION("Move construct") {
            Text test = "Hi";
            Text test2(std::move(test));
            REQUIRE(test2 == "Hi");
            REQUIRE(test == "");
            auto test3 = std::move(test2);
            REQUIRE(test == "");
            REQUIRE(test3 == "Hi");
        }

        SECTION("Comparison") {
            REQUIRE(Text("hi there") < Text("hi there1"));
            REQUIRE(Text("hi there1") > Text("hi there"));
            REQUIRE(!(Text("hi there") > Text("hi there")));
            REQUIRE(!(Text("hi there") < Text("hi there")));
        }

        SECTION("lowerCase") {
            REQUIRE(Text("WHY ARE YOU YELLING").lowerCase() ==
                    "why are you yelling");
        }

        SECTION("upperCase") {
            REQUIRE(Text("i can't hear you").upperCase() == "I CAN'T HEAR YOU");
        }

        SECTION("trim") {
            REQUIRE(Text("   i can't hear you    ").trim() ==
                    "i can't hear you");
        }

        SECTION("removeQuotes") {
            REQUIRE(Text("\"Fact\"").removeQuotes() == "Fact");
        }

        SECTION("split") {
            auto comps = Text(",1,2,3,4,").split(',');
            REQUIRE(comps == std::vector<Text>{"1", "2", "3", "4"});
            comps = Text(",1,2,3,4,").split(',', true);
            REQUIRE(comps == std::vector<Text>{"", "1", "2", "3", "4", ""});
        }

        SECTION("concat") {
            REQUIRE(concat(std::vector<Text>{"1", "2", "3", "4"}, ",") ==
                    "1,2,3,4");
            REQUIRE(concat(std::vector<Text>{"1", "2", "3", "4"}, "") ==
                    "1234");
            REQUIRE(concat(std::vector<Text>{"1", "2", "", "4"}, ",", false) ==
                    "1,2,4");
            REQUIRE(concat(std::vector<Text>{"1", "2", "", "4"}, ",", true) ==
                    "1,2,,4");
        }

        SECTION("endsWith") {
            REQUIRE(Text("There once was a").endsWith("once was a"));
            REQUIRE(Text("There once was a").endsWith("nce was a"));
            REQUIRE(Text("There once was a").endsWith("ce was a"));
            REQUIRE(Text("There once was a").endsWith("e was a"));
            REQUIRE(Text("There once was a").endsWith("a"));

            REQUIRE(!Text("There once was a").endsWith(""));

            REQUIRE(Text("There once was a").endsWith("once was A", false));
            REQUIRE(Text("There once was a").endsWith("nce Was a", false));
            REQUIRE(Text("There once was a").endsWith("cE was a", false));
            REQUIRE(Text("There once was a").endsWith("e was A", false));
            REQUIRE(Text("There once was a").endsWith("A", false));

            REQUIRE(!Text("There once was a").endsWith("once was A", true));
            REQUIRE(!Text("There once was a").endsWith("nce Was a", true));
            REQUIRE(!Text("There once was a").endsWith("cE was a", true));
            REQUIRE(!Text("There once was a").endsWith("e was A", true));
            REQUIRE(!Text("There once was a").endsWith("A", true));
        }

        SECTION("startsWith") {
            REQUIRE(Text("There once was a").startsWith("There once was a"));
            REQUIRE(Text("There once was a").startsWith("There once "));
            REQUIRE(Text("There once was a").startsWith("There "));
            REQUIRE(Text("There once was a").startsWith("T"));

            REQUIRE(!Text("There once was a").startsWith(""));

            REQUIRE(
                Text("There once was a").startsWith("there Once was a", false));
            REQUIRE(Text("There once was a").startsWith("there once ", false));
            REQUIRE(Text("There once was a").startsWith("ThErE", false));
            REQUIRE(Text("There once was a").startsWith("t", false));

            REQUIRE(
                !Text("There once was a").startsWith("there Once was a", true));
            REQUIRE(!Text("There once was a").startsWith("there once ", true));
            REQUIRE(!Text("There once was a").startsWith("ThErE", true));
            REQUIRE(!Text("There once was a").startsWith("t", true));
        }

        SECTION("remove") {
            REQUIRE(Text("DO NOT CENSOR ME").remove("NOT ") == "DO CENSOR ME");
            REQUIRE(Text("DO NOT NOT NOT CENSOR ME").remove("NOT ") ==
                    "DO CENSOR ME");
            REQUIRE(Text("I SAID, DO NOT CENSOR ME")
                        .remove("I ", "SAID, ", " NOT") == "DO CENSOR ME");
        }

        SECTION("replace") {
            REQUIRE(Text("DO NOT CENSOR ME").replace("DO NOT ", "DO ") ==
                    "DO CENSOR ME");
            REQUIRE(Text("DO NOT NOT NOT CENSOR ME").replace("NOT ", "") ==
                    "DO CENSOR ME");
            REQUIRE(Text("I SAID, DO NOT CENSOR ME")
                        .replace("I SAID, ", "I DIDN'T SAY, ") ==
                    "I DIDN'T SAY, DO NOT CENSOR ME");
        }

        SECTION("replaceAnyOf") {
            REQUIRE(Text("ABCDEF").replaceAnyOf("ACF", 'X') == "XBXDEX");
        }

        SECTION("Append rvalue") {
            Text lh;
            Text rh("right");
            // Empty string on left-hand side of append(&&) should move
            // right-hand side
            lh.append(_mv(rh));
            REQUIRE(lh == "right");
            REQUIRE(rh.empty());
        }

        SECTION("operator += rvalue") {
            Text lh;
            Text rh("right");
            // Empty string on left-hand side of +=(&&) should move right-hand
            // side
            lh += _mv(rh);
            REQUIRE(lh == "right");
            REQUIRE(rh.empty());
        }

        SECTION("substr") {
            using string::npos;
            Text str("excellent");

            // Test both substr and substrView
            auto verify = [&](size_t pos, size_t count, TextView expected) {
                REQUIRE(str.substr(pos, count) == expected);
                REQUIRE(str.substrView(pos, count) == expected);
            };

            verify(0, 0, {});
            verify(0, npos, str);
            verify(str.length(), 42, {});

            verify(0, 5, "excel"_tv);
            verify(1, 5, "xcell"_tv);

            verify(6, 3, "ent"_tv);
            verify(6, 4, "ent"_tv);
        }
    }

#if WIN32
    SECTION("Utf16") {
        SECTION("Implicit cast") {
            Utf16 test = L"test";
            REQUIRE(Utf16eql(static_cast<const Utf16Chr *>(test), L"test"));
            REQUIRE(test);
        }

        SECTION("Move assign") {
            Utf16 test = L"Hi";
            Utf16 test2 = std::move(test);
            REQUIRE(test2 == L"Hi");
            REQUIRE(test == L"");
            auto test3 = std::move(test2);
            REQUIRE(test == L"");
            REQUIRE(test3 == L"Hi");
        }

        SECTION("Move construct") {
            Utf16 test = L"Hi";
            Utf16 test2(std::move(test));
            REQUIRE(test2 == L"Hi");
            REQUIRE(test == L"");
            auto test3 = std::move(test2);
            REQUIRE(test == L"");
            REQUIRE(test3 == L"Hi");
        }

        SECTION("Comparison") {
            REQUIRE(Utf16(L"hi there") < Utf16(L"hi there1"));
            REQUIRE(Utf16(L"hi there1") > Utf16(L"hi there"));
            REQUIRE(!(Utf16(L"hi there") > Utf16(L"hi there")));
            REQUIRE(!(Utf16(L"hi there") < Utf16(L"hi there")));
        }

        SECTION("lowerCase") {
            REQUIRE(Utf16(L"WHY ARE YOU YELLING").lowerCase() ==
                    L"why are you yelling");
        }

        SECTION("upperCase") {
            REQUIRE(Utf16(L"i can't hear you").upperCase() ==
                    L"I CAN'T HEAR YOU");
        }

        SECTION("trim") {
            auto bobo = Utf16(L"   i can't hear you    ");
            bobo.trim();
            REQUIRE(bobo == L"i can't hear you");
        }

        SECTION("removeQuotes") {
            REQUIRE(Utf16(L"\"Fact\"").removeQuotes() == L"Fact");
        }

        SECTION("split") {
            auto comps = Utf16(L",1,2,3,4,").split(',');
            REQUIRE(comps == std::vector<Utf16>{L"1", L"2", L"3", L"4"});
            comps = Utf16(L",1,2,3,4,").split(u',', true);
            REQUIRE(comps ==
                    std::vector<Utf16>{L"", L"1", L"2", L"3", L"4", L""});
        }

        SECTION("endsWith") {
            REQUIRE(Utf16(L"There once was a").endsWith(L"once was a"));
            REQUIRE(Utf16(L"There once was a").endsWith(L"nce was a"));
            REQUIRE(Utf16(L"There once was a").endsWith(L"ce was a"));
            REQUIRE(Utf16(L"There once was a").endsWith(L"e was a"));
            REQUIRE(Utf16(L"There once was a").endsWith(L"a"));

            REQUIRE(!Utf16(L"There once was a").endsWith(L""));

            REQUIRE(Utf16(L"There once was a").endsWith(L"once was A", false));
            REQUIRE(Utf16(L"There once was a").endsWith(L"nce Was a", false));
            REQUIRE(Utf16(L"There once was a").endsWith(L"cE was a", false));
            REQUIRE(Utf16(L"There once was a").endsWith(L"e was A", false));
            REQUIRE(Utf16(L"There once was a").endsWith(L"A", false));

            REQUIRE(!Utf16(L"There once was a").endsWith(L"once was A", true));
            REQUIRE(!Utf16(L"There once was a").endsWith(L"nce Was a", true));
            REQUIRE(!Utf16(L"There once was a").endsWith(L"cE was a", true));
            REQUIRE(!Utf16(L"There once was a").endsWith(L"e was A", true));
            REQUIRE(!Utf16(L"There once was a").endsWith(L"A", true));
        }

        SECTION("startsWith") {
            REQUIRE(Utf16(L"There once was a").startsWith(L"There once was a"));
            REQUIRE(Utf16(L"There once was a").startsWith(L"There once "));
            REQUIRE(Utf16(L"There once was a").startsWith(L"There "));
            REQUIRE(Utf16(L"There once was a").startsWith(L"T"));

            REQUIRE(!Utf16(L"There once was a").startsWith(L""));

            REQUIRE(Utf16(L"There once was a")
                        .startsWith(L"there Once was a", false));
            REQUIRE(
                Utf16(L"There once was a").startsWith(L"there once ", false));
            REQUIRE(Utf16(L"There once was a").startsWith(L"ThErE", false));
            REQUIRE(Utf16(L"There once was a").startsWith(L"t", false));

            REQUIRE(!Utf16(L"There once was a")
                         .startsWith(L"there Once was a", true));
            REQUIRE(
                !Utf16(L"There once was a").startsWith(L"there once ", true));
            REQUIRE(!Utf16(L"There once was a").startsWith(L"ThErE", true));
            REQUIRE(!Utf16(L"There once was a").startsWith(L"t", true));
        }

        SECTION("equals") {
            REQUIRE(Utf16eql(L"Do you equal me", L"Do you equal me"));
            REQUIRE(Utf16ieql(L"Do you equal me", L"Do you equal me"));

            REQUIRE(!Utf16eql(L"Do you equal me", L"do you equal me"));
            REQUIRE(Utf16ieql(L"Do you equal me", L"do you equal me"));
        }

        SECTION("remove") {
            REQUIRE(Utf16(L"DO NOT CENSOR ME").remove(L"NOT ") ==
                    L"DO CENSOR ME");
            REQUIRE(Utf16(L"DO NOT NOT NOT CENSOR ME").remove(L"NOT ") ==
                    L"DO CENSOR ME");
            REQUIRE(Utf16(L"I SAID, DO NOT CENSOR ME")
                        .remove(L"I ", L"SAID, ", L" NOT") == L"DO CENSOR ME");
        }

        SECTION("replace") {
            REQUIRE(Utf16(L"DO NOT CENSOR ME").replace(L"DO NOT ", L"DO ") ==
                    L"DO CENSOR ME");
            REQUIRE(Utf16(L"DO NOT NOT NOT CENSOR ME").replace(L"NOT ", L"") ==
                    L"DO CENSOR ME");
            REQUIRE(Utf16(L"I SAID, DO NOT CENSOR ME")
                        .replace(L"I SAID, ", L"I DIDN'T SAY, ") ==
                    L"I DIDN'T SAY, DO NOT CENSOR ME");
        }
    }
#endif
#if 0
	SECTION("Utf32") {
		SECTION("Implicit cast") {
			Utf32 test = L"test";
			REQUIRE(!Utf32cmp(test, L"test"));
			REQUIRE(test);
		}

		SECTION("Move assign") {
			Utf32 test = L"Hi";
			Utf32 test2 = std::move(test);
			REQUIRE(test2 == L"Hi");
			REQUIRE(test == L"");
			auto test3 = std::move(test2);
			REQUIRE(test == L"");
			REQUIRE(test3 == L"Hi");
		}

		SECTION("Move construct") {
			Utf32 test = L"Hi";
			Utf32 test2(std::move(test));
			REQUIRE(test2 == L"Hi");
			REQUIRE(test == L"");
			auto test3 = std::move(test2);
			REQUIRE(test == L"");
			REQUIRE(test3 == L"Hi");
		}

		SECTION("Comparison") {
			REQUIRE(Utf32(L"hi there") < Utf32(L"hi there1"));
			REQUIRE(Utf32(L"hi there1") > Utf32(L"hi there"));
			REQUIRE(!(Utf32(L"hi there") > Utf32(L"hi there")));
			REQUIRE(!(Utf32(L"hi there") < Utf32(L"hi there")));
		}

		SECTION("lowerCase") {
			REQUIRE(Utf32(L"WHY ARE YOU YELLING").lowerCase() == L"why are you yelling");
		}

		SECTION("upperCase") {
			REQUIRE(Utf32(L"i can't hear you").upperCase() == L"I CAN'T HEAR YOU");
		}

		SECTION("trim") {
			REQUIRE(Utf32(L"   i can't hear you    ").trim() == L"i can't hear you");
		}

		SECTION("removeQuotes") {
			REQUIRE(Utf32(L"\"Fact\"").removeQuotes() == L"Fact");
		}

		SECTION("split") {
			auto comps = Utf32(L",1,2,3,4,").split(',');
			REQUIRE(comps == std::vector<Utf32>{L"1", L"2", L"3", L"4"});
			comps = Utf32(L",1,2,3,4,").split(u',', true);
			REQUIRE(comps == std::vector<Utf32>{L"", L"1", L"2", L"3", L"4", L""});
		}

		SECTION("endsWith") {
			REQUIRE(Utf32(L"There once was a").endsWith(L"once was a"));
			REQUIRE(Utf32(L"There once was a").endsWith(L"nce was a"));
			REQUIRE(Utf32(L"There once was a").endsWith(L"ce was a"));
			REQUIRE(Utf32(L"There once was a").endsWith(L"e was a"));
			REQUIRE(Utf32(L"There once was a").endsWith(L"a"));

			REQUIRE(!Utf32(L"There once was a").endsWith(L""));

			REQUIRE(Utf32(L"There once was a").endsWith(L"once was A", false));
			REQUIRE(Utf32(L"There once was a").endsWith(L"nce Was a", false));
			REQUIRE(Utf32(L"There once was a").endsWith(L"cE was a", false));
			REQUIRE(Utf32(L"There once was a").endsWith(L"e was A", false));
			REQUIRE(Utf32(L"There once was a").endsWith(L"A", false));

			REQUIRE(!Utf32(L"There once was a").endsWith(L"once was A", true));
			REQUIRE(!Utf32(L"There once was a").endsWith(L"nce Was a", true));
			REQUIRE(!Utf32(L"There once was a").endsWith(L"cE was a", true));
			REQUIRE(!Utf32(L"There once was a").endsWith(L"e was A", true));
			REQUIRE(!Utf32(L"There once was a").endsWith(L"A", true));
		}

		SECTION("startsWith") {
			REQUIRE(Utf32(L"There once was a").startsWith(L"There once was a"));
			REQUIRE(Utf32(L"There once was a").startsWith(L"There once "));
			REQUIRE(Utf32(L"There once was a").startsWith(L"There "));
			REQUIRE(Utf32(L"There once was a").startsWith(L"T"));

			REQUIRE(!Utf32(L"There once was a").startsWith(L""));

			REQUIRE(Utf32(L"There once was a").startsWith(L"there Once was a", false));
			REQUIRE(Utf32(L"There once was a").startsWith(L"there once ", false));
			REQUIRE(Utf32(L"There once was a").startsWith(L"ThErE", false));
			REQUIRE(Utf32(L"There once was a").startsWith(L"t", false));

			REQUIRE(!Utf32(L"There once was a").startsWith(L"there Once was a", true));
			REQUIRE(!Utf32(L"There once was a").startsWith(L"there once ", true));
			REQUIRE(!Utf32(L"There once was a").startsWith(L"ThErE", true));
			REQUIRE(!Utf32(L"There once was a").startsWith(L"t", true));
		}

		SECTION("equals") {
			REQUIRE(Utf32eql(L"Do you equal me", L"Do you equal me"));
			REQUIRE(Utf32ieql(L"Do you equal me", L"Do you equal me"));

			REQUIRE(!Utf32eql(L"Do you equal me", L"do you equal me"));
			REQUIRE(Utf32ieql(L"Do you equal me", L"do you equal me"));
		}

		SECTION("remove") {
			REQUIRE(Utf32(L"DO NOT CENSOR ME").remove(L"NOT ") == L"DO CENSOR ME");
			REQUIRE(Utf32(L"DO NOT NOT NOT CENSOR ME").remove(L"NOT ") == L"DO CENSOR ME");
			REQUIRE(Utf32(L"I SAID, DO NOT CENSOR ME").remove(L"I ", L"SAID, ", L" NOT") == L"DO CENSOR ME");
		}

		SECTION("replace") {
			REQUIRE(Utf32(L"DO NOT CENSOR ME").replace(L"DO NOT ", L"DO ") == L"DO CENSOR ME");
			REQUIRE(Utf32(L"DO NOT NOT NOT CENSOR ME").replace(L"NOT ", L"") == L"DO CENSOR ME");
			REQUIRE(Utf32(L"I SAID, DO NOT CENSOR ME").replace(L"I SAID, ", L"I DIDN'T SAY, ") == L"I DIDN'T SAY, DO NOT CENSOR ME");
		}
	}
#endif
}
