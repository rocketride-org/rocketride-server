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

// Coverage for format apis in string
TEST_CASE("string::format") {
    SECTION("SummaryFormat constexpr") {
        auto result = string::format(
            R"({"s":{,~X},"e":{,~X},"d":{,~X},"c":{,~X}})", 12, 13, 14, 15);
        REQUIRE(result == R"({"s":c,"e":d,"d":e,"c":f})");
    }

    SECTION("packNumber") {
        SECTION("fromString") {
            auto res = string::fromString<uint64_t>("1234");
            REQUIRE(res == 1234);
        }

        SECTION("Format") {
            SECTION("Format two numbers auto order") {
                auto result = string::format("{}{}", 1234, 5678);
                REQUIRE(result == "12345678");
            }

            SECTION("Ignore invalid fields") {
                auto result = string::format("{{alkjsdhakjd}}}}{{", 1234, 5678);
                REQUIRE(result == "{{alkjsdhakjd}}}}{{12345678");
            }

            SECTION("Format two numbers in order") {
                auto result = string::format("{0}{1}", 1234, 5678);
                REQUIRE(result == "12345678");
            }

            SECTION("Format two numbers out of order") {
                auto result = string::format("{1}{0}", 1234, 5678);
                REQUIRE(result == "56781234");
            }

            SECTION("Format two strings in order") {
                auto fmt = string::FormatStr<>("{0}{1}");
                auto result = string::format("{0}{1}", "1234", "5678");
                REQUIRE(result == "12345678");
            }

            SECTION("Format two strings out of order") {
                auto result = string::format("{1}{0}", "1234", "5678");
                REQUIRE(result == "56781234");
            }

            SECTION("Format two strings implied ordering") {
                auto result =
                    string::format("Hey we logged something {}/{}",
                                   "A string that isn't a text but should work",
                                   "Another string here that should work");
                REQUIRE(result ==
                        "Hey we logged something A string that isn't a text "
                        "but should work/Another string here that should work");
            }

            SECTION("Format two strings explicit ordering") {
                auto result =
                    string::format("Hey we logged something {0}/{1}",
                                   "A string that isn't a text but should work",
                                   "Another string here that should work");
                REQUIRE(result ==
                        "Hey we logged something A string that isn't a text "
                        "but should work/Another string here that should work");
            }

            SECTION("Format two strings explicit ordering reversed") {
                auto result =
                    string::format("Hey we logged something {1}/{0}",
                                   "A string that isn't a text but should work",
                                   "Another string here that should work");
                REQUIRE(
                    result ==
                    "Hey we logged something Another string here that should "
                    "work/A string that isn't a text but should work");
            }
        }

        SECTION("Status spacing with title") {
            Text pattern =
                "C:/code/rocketride-app/build/rocketride/engine/x64/Release/"
                "windows/test_files/engine.classify/123378/backup";
            auto pTitle = "Source Paths";
            auto pMessage = "Include";
            auto text = string::format("    {,,31} : {,,12} {}\n", pTitle,
                                       pMessage, &pattern);
            REQUIRE(
                text ==
                "    Source Paths                    : Include      "
                "C:/code/rocketride-app/build/rocketride/engine/x64/Release/"
                "windows/test_files/engine.classify/123378/backup\n");
        }

        SECTION("Status spacing with null title") {
            Text pattern =
                "C:/code/rocketride-app/build/rocketride/engine/x64/Release/"
                "windows/test_files/engine.classify/123378/backup";
            auto pTitle = nullptr;
            auto pMessage = "Include";
            auto text = string::format("    {,,31} : {,,12} {}\n", pTitle,
                                       pMessage, &pattern);
            REQUIRE(
                text ==
                "                                    : Include      "
                "C:/code/rocketride-app/build/rocketride/engine/x64/Release/"
                "windows/test_files/engine.classify/123378/backup\n");
        }
    }

    SECTION("Unpack String") {
        SECTION("Text string") {
            REQUIRE(_fs<Text>("true") == "true");
            REQUIRE(_fs<Text>("Hi there this is some string ok") ==
                    "Hi there this is some string ok");
        }

        SECTION("Empty string") {
            // Unpacking an empty string for these types should yield an error,
            // not abort ints are excepted - they unpack to 0
            Text empty;
            REQUIRE_THROWS(*_fsc<bool>(empty, {}));
            REQUIRE_THROWS(*_fsc<float>(empty, {}));
            REQUIRE_THROWS(*_fsc<float>(empty, {Format::HEX}));
        }

#if ROCKETRIDE_PLAT_WIN
        SECTION("Utf16 string") {
            REQUIRE(_fs<Text>(L"true") == "true");
            REQUIRE(_fs<Text>(L"Hi there this is some string ok") ==
                    "Hi there this is some string ok");
        }
#endif
    }

    SECTION("Unpack Integral") {
        SECTION("Bool") {
            REQUIRE(_fs<bool>("true") == true);
            REQUIRE(_fs<bool>("false") == false);
            REQUIRE(_fs<bool>("TrUe") == true);
            REQUIRE(_fs<bool>("FaLse") == false);

            REQUIRE(_fs<bool>("FaLse0x0asd") == false);
        }

        SECTION("uint8_t") {
            REQUIRE(_fs<uint8_t>("123") == 123);
            REQUIRE(_fs<uint8_t>("0xFF") == 255);
            REQUIRE(_fs<uint8_t>("0x3F") == 0x3f);
            REQUIRE(_fso<uint8_t>(Format::HEX, "FF") == 255);
            REQUIRE(_fso<uint8_t>(Format::HEX, "3F") == 0x3f);

            REQUIRE(_fso<uint8_t>(Format::HEX, "3F121a") == 0x3f);
        }

        SECTION("uint16_t") {
            REQUIRE(_fs<uint16_t>("6512") == 6512);
            REQUIRE(_fso<uint16_t>(Format::GROUP, "6,512") == 6512);
            REQUIRE(_fs<uint16_t>("0xFFFF") == 0xFFFF);
            REQUIRE(_fs<uint16_t>("0x003F") == 0x003f);
            REQUIRE(_fso<uint16_t>(Format::HEX, "10FF") == 0x10FF);
            REQUIRE(_fso<uint16_t>(Format::HEX, "103F") == 0x103f);

            REQUIRE(_fso<uint16_t>(Format::HEX, "103FF121") == 0x103f);
        }

        SECTION("uint32_t") {
            REQUIRE(_fs<uint32_t>("1234567891") == 1234567891);
            REQUIRE(_fso<uint32_t>(Format::GROUP, "1,234,567,891") ==
                    1234567891);
            REQUIRE(_fs<uint32_t>("0xFFFFFFFF") == 0xFFFFFFFF);
            REQUIRE(_fso<uint32_t>(Format::GROUP, "0xFFFF:FFFF") == 0xFFFFFFFF);
            REQUIRE(_fs<uint32_t>("0x1000003F") == 0x1000003F);
            REQUIRE(_fso<uint32_t>(Format::HEX, "1000003f") == 0x1000003F);
            REQUIRE(_fso<uint32_t>(Format::HEX | Format::GROUP, "1000003f") ==
                    0x1000003F);
            REQUIRE(_fso<uint32_t>(Format::HEX | Format::GROUP, "1000:003f") ==
                    0x1000003F);

            REQUIRE(_fso<uint32_t>(Format::HEX | Format::GROUP,
                                   "1000:003f1111") == 0x1000003F);
        }

        SECTION("uint64_t") {
            REQUIRE(_fs<uint64_t>("12345678912341241") == 12345678912341241);
            REQUIRE(_fso<uint64_t>(Format::GROUP, "12,345,678,912,341,241") ==
                    12345678912341241);
            REQUIRE(_fs<uint64_t>("0xFFFFFFFFFFFFFFFF") == 0xFFFFFFFFFFFFFFFF);
            REQUIRE(_fso<uint64_t>(Format::GROUP, "0xFFFF:FFFF:FFFF:FFFF") ==
                    0xFFFFFFFFFFFFFFFF);
            REQUIRE(_fs<uint64_t>("0x100101001100003F") == 0x100101001100003F);
            REQUIRE(_fso<uint64_t>(Format::HEX, "FFFFFFFFFFFFFFFF") ==
                    0xFFFFFFFFFFFFFFFF);
            REQUIRE(_fso<uint64_t>(Format::HEX, "100101001100003F") ==
                    0x100101001100003F);
        }
    }  // section unpack integral

    SECTION("User formatters") {}

    SECTION("format") {
        SECTION("uint8_t") {
            uint8_t val = 1;

            SECTION("zero fill") {
                auto result = string::format("{,0}", val);
                REQUIRE(result == "001");
                result = string::format("{,0,1}", val);
                REQUIRE(result == "1");
                result = string::format("{,0,2}", val);
                REQUIRE(result == "01");
                result = string::format("{,0,3}", val);
                REQUIRE(result == "001");
                result = string::format("{,0,15}", val);
                REQUIRE(result == "000000000000001");
            }

            SECTION("space fill right justified") {
                auto result = string::format("{,,1}", val);
                REQUIRE(result == "1");
                result = string::format("{,,2}", val);
                auto fmt = string::FormatStr<>("{,,2}");
                REQUIRE(result == " 1");
                result = string::format("{,,3}", val);
                REQUIRE(result == "  1");
                result = string::format("{,,4}", val);
                REQUIRE(result == "   1");
                result = string::format("{,,5}", val);
                REQUIRE(result == "    1");
                result = string::format("{,,10}", val);
                REQUIRE(result == "         1");
            }

            SECTION("space fill left justified") {
                auto result = string::format("{,-,1}", val);
                REQUIRE(result == "1");
                result = string::format("{,-,2}", val);
                REQUIRE(result == "1 ");
                result = string::format("{,-,3}", val);
                REQUIRE(result == "1  ");
                result = string::format("{,-,10}", val);
                REQUIRE(result == "1         ");
            }

            SECTION("hex with prefix left justified") {
                auto result = string::format("{,x,1}", val);
                REQUIRE(result == "0x1");
                result = string::format("{,x,2}", val);
                REQUIRE(result == "0x01");
                result = string::format("{,x,3}", val);
                REQUIRE(result == "0x001");
                result = string::format("{,x,10}", val);
                REQUIRE(result == "0x0000000001");
            }

            SECTION("hex with prefix left justified no group") {
                auto result = string::format("{,x,1}", val);
                REQUIRE(result == "0x1");
                result = string::format("{,x,2}", val);
                REQUIRE(result == "0x01");
                result = string::format("{,x,3}", val);
                REQUIRE(result == "0x001");
                result = string::format("{,x,10}", val);
                REQUIRE(result == "0x0000000001");
            }

            SECTION("hex with prefix space fill right") {
                auto result = string::format("{,-x,1}", val);
                REQUIRE(result == "0x1");
                result = string::format("{,-x,2}", val);
                REQUIRE(result == "0x1 ");
                result = string::format("{,-x,3}", val);
                REQUIRE(result == "0x1  ");
                result = string::format("{,-x,10}", val);
                REQUIRE(result == "0x1         ");
            }

            SECTION("hex no prefix left justified") {
                auto result = string::format("{,X,1}", val);
                REQUIRE(result == "1");
                result = string::format("{,X,2}", val);
                REQUIRE(result == "01");
                result = string::format("{,X,3}", val);
                REQUIRE(result == "001");
                result = string::format("{,X,10}", val);
                REQUIRE(result == "0000000001");
            }

            SECTION("hex no prefix left justified no group") {
                auto result = string::format("{,X,1}", val);
                REQUIRE(result == "1");
                result = string::format("{,X,2}", val);
                REQUIRE(result == "01");
                result = string::format("{,X,3}", val);
                REQUIRE(result == "001");
                result = string::format("{,X,10}", val);
                REQUIRE(result == "0000000001");
            }

            SECTION("hex no prefix space fill right") {
                auto result = string::format("{,-X,1}", val);
                REQUIRE(result == "1");
                result = string::format("{,-X,2}", val);
                REQUIRE(result == "1 ");
                result = string::format("{,-X,3}", val);
                REQUIRE(result == "1  ");
                result = string::format("{,-X,10}", val);
                REQUIRE(result == "1         ");
            }
        }

        SECTION("uint64_t") {
            uint64_t val = 0xFAFEEA1;  // 263188129
            SECTION("zero fill") {
                auto result = string::format("{,0}", val);
                REQUIRE(result == "00000000000263188129");
                result = string::format("{,0,1}", val);
                REQUIRE(result == "263188129");
                result = string::format("{,0,2}", val);
                REQUIRE(result == "263188129");
                result = string::format("{,0,3}", val);
                REQUIRE(result == "263188129");
                result = string::format("{,0,8}", val);
                REQUIRE(result == "263188129");
                result = string::format("{,0,9}", val);
                REQUIRE(result == "263188129");
                result = string::format("{,,10}", val);
                REQUIRE(result == " 263188129");
                result = string::format("{,,11}", val);
                REQUIRE(result == "  263188129");
                result = string::format("{,0,15}", val);
                REQUIRE(result == "000000263188129");
            }

            SECTION("space fill right justified") {
                auto result = string::format("{,-,1}"_tv, val);
                REQUIRE(result == "263188129");
                result = string::format("{,-,2}"_tv, val);
                REQUIRE(result == "263188129");
                result = string::format("{,-,3}"_tv, val);
                REQUIRE(result == "263188129");
                result = string::format("{,-,4}"_tv, val);
                REQUIRE(result == "263188129");
                result = string::format("{,-,5}"_tv, val);
                REQUIRE(result == "263188129");
                result = string::format("{,-,10}"_tv, val);
                REQUIRE(result == "263188129 ");
                result = string::format("{,-,11}"_tv, val);
                REQUIRE(result == "263188129  ");
                result = string::format("{,-,12}"_tv, val);
                REQUIRE(result == "263188129   ");
            }

            SECTION("space fill left justified modifier") {
                auto result = string::format("{,,1}", val);
                REQUIRE(result == "263188129");
                result = string::format("{,,2}", val);
                REQUIRE(result == "263188129");
                result = string::format("{,,3}", val);
                REQUIRE(result == "263188129");
                result = string::format("{,,10}", val);
                REQUIRE(result == " 263188129");
                result = string::format("{,,11}", val);
                REQUIRE(result == "  263188129");
                result = string::format("{,,12}", val);
                REQUIRE(result == "   263188129");
            }

            SECTION("hex with prefix left justified") {
                auto result = string::format("{,x,1}"_tv, val);
                REQUIRE(result == "0xfafeea1");
                result = string::format("{,x,2}"_tv, val);
                REQUIRE(result == "0xfafeea1");
                result = string::format("{,x,3}"_tv, val);
                REQUIRE(result == "0xfafeea1");
                result = string::format("{,x,10}"_tv, val);
                REQUIRE(result == "0x000fafeea1");
                result = string::format("{,x,11}"_tv, val);
                REQUIRE(result == "0x0000fafeea1");
                result = string::format("{,x,12}"_tv, val);
                REQUIRE(result == "0x00000fafeea1");
            }

            SECTION("hex with prefix left justified no group") {
                auto result = string::format("{,x,1}"_tv, val);
                REQUIRE(result == "0xfafeea1");
                result = string::format("{,x,2}"_tv, val);
                REQUIRE(result == "0xfafeea1");
                result = string::format("{,x,3}"_tv, val);
                REQUIRE(result == "0xfafeea1");
                result = string::format("{,x,10}"_tv, val);
                REQUIRE(result == "0x000fafeea1");
                result = string::format("{,x,11}"_tv, val);
                REQUIRE(result == "0x0000fafeea1");
                result = string::format("{,x,12}"_tv, val);
                REQUIRE(result == "0x00000fafeea1");
            }

            SECTION("hex with prefix space fill right group") {
                auto result = string::format("{,x,1}", val);
                REQUIRE(result == "0xfafeea1");
                result = string::format("{,-x,2}", val);
                REQUIRE(result == "0xfafeea1");
                result = string::format("{,-x,3}", val);
                REQUIRE(result == "0xfafeea1");
                result = string::format("{,-x,10}", val);
                REQUIRE(result == "0xfafeea1   ");
                result = string::format("{,-x,11}", val);
                REQUIRE(result == "0xfafeea1    ");
                result = string::format("{,-x,12}", val);
                REQUIRE(result == "0xfafeea1     ");
            }

            SECTION("hex no prefix left justified") {
                auto result = string::format("{,X,1}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,X,2}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,X,3}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,X,10}"_tv, val);
                REQUIRE(result == "000fafeea1");
                result = string::format("{,X,11}"_tv, val);
                REQUIRE(result == "0000fafeea1");
                result = string::format("{,X,12}"_tv, val);
                REQUIRE(result == "00000fafeea1");
            }

            SECTION("hex no prefix left justified no group") {
                auto result = string::format("{,X,1}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,X,2}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,X,3}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,X,10}"_tv, val);
                REQUIRE(result == "000fafeea1");
                result = string::format("{,X,11}"_tv, val);
                REQUIRE(result == "0000fafeea1");
                result = string::format("{,X,12}"_tv, val);
                REQUIRE(result == "00000fafeea1");
            }

            SECTION(
                "hex no prefix right justified no group (different order from "
                "original)") {
                auto result = string::format("{,-X,1}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,-X,2}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,-X,3}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,-X,10}"_tv, val);
                REQUIRE(result == "fafeea1   ");
                result = string::format("{,-X,11}"_tv, val);
                REQUIRE(result == "fafeea1    ");
                result = string::format("{,-X,12}"_tv, val);
                REQUIRE(result == "fafeea1     ");
            }

            SECTION(
                "hex no prefix right justified no group (same order from "
                "original)") {
                auto result = string::format("{,-X,1}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,-X,2}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,-X,3}"_tv, val);
                REQUIRE(result == "fafeea1");
                result = string::format("{,-X,10}"_tv, val);
                REQUIRE(result == "fafeea1   ");
                result = string::format("{,-X,11}"_tv, val);
                REQUIRE(result == "fafeea1    ");
                result = string::format("{,-X,12}"_tv, val);
                REQUIRE(result == "fafeea1     ");
            }
        }
    }

    SECTION("std::from_chars") {
        auto numStr = "1234";
        uint64_t num;
        std::from_chars(numStr, numStr + Txtlen(numStr), num);
        REQUIRE(num == 1234);
    }

    SECTION("Format JSON") {
        REQUIRE(string::format(R"({"segmentName": "{}"})", "segment.dat") ==
                R"({"segmentName": "segment.dat"})");
    }
}
