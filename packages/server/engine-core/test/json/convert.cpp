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
#include <locale>

TEST_CASE("json::convert") {
    SECTION("list") {
        std::list<int> nums = {1, 2, 3, 4, 5};
        auto val = _tj(nums);
        auto nums2 = _fj<decltype(nums)>(val);
        REQUIRE(nums == nums2);
    }

    SECTION("vector") {
        std::vector<int> nums = {1, 2, 3, 4, 5};
        auto val = _tj(nums);
        auto nums2 = _fj<decltype(nums)>(val);
        REQUIRE(nums == nums2);
    }

    SECTION("set") {
        std::set<int> nums = {1, 2, 3, 4, 5};
        auto val = _tj(nums);
        auto nums2 = _fj<decltype(nums)>(val);
        REQUIRE(nums == nums2);
    }

    SECTION("FlatSet") {
        FlatSet<int> nums = {1, 2, 3, 4, 5};
        auto val = _tj(nums);
        auto nums2 = _fj<decltype(nums)>(val);
        REQUIRE(nums == nums2);
    }

    SECTION("Optional") {
        // toJson on NullOpt should yield null json::Value
        REQUIRE(_tj(Opt<Text>()).type() == json::ValueType::nullValue);

        // toJson on optional with a value should yield toJson on the held value
        REQUIRE(_tj(Opt<Text>("Text")) == "Text");

        // fromJson on a null json::Value should yield NullOpt
        REQUIRE(_fj<Opt<Text>>(json::Value()) == NullOpt);

        // fromJson on a json::Value should yield an optional with the correct
        // held value
        REQUIRE(*_fj<Opt<Text>>(json::Value("Text")) == "Text");
    }

    SECTION("Error propagation") {
        json::Value json;

        struct ReturnsSuccess {
            static Error __fromJson(ReturnsSuccess &,
                                    const json::Value &) noexcept {
                return {};
            }
        };
        REQUIRE(_fjc<ReturnsSuccess>(json));

        struct ReturnsError {
            static Error __fromJson(ReturnsError &,
                                    const json::Value &) noexcept {
                return APERR(Ec::InvalidJson, "Invalid");
            }
        };
        REQUIRE_FALSE(_fjc<ReturnsError>(json));

        struct ThrowsNothing {
            static ThrowsNothing __fromJson(const json::Value &) noexcept(
                false) {
                return ThrowsNothing();
            }
        };
        REQUIRE(_fjc<ThrowsNothing>(json));

        struct ThrowsException {
            static ThrowsException __fromJson(const json::Value &) noexcept(
                false) {
                APERR_THROW(Ec::InvalidJson, "Invalid");
            }
        };
        REQUIRE_FALSE(_fjc<ThrowsException>(json));
    }

    SECTION("Codepoints to UTF-8") {
        json::Value root;
        json::Reader reader;

        // Test codepoints <= 0x7f
        REQUIRE(reader.parse("{ \"code\":\"\\u002a\" }", root, false));
        REQUIRE(root["code"] == json::Value{"*"});

        REQUIRE(reader.parse("{ \"code\":\"\\u007e\" }", root, false));
        REQUIRE(root["code"] == json::Value{"~"});

        REQUIRE(reader.parse("{ \"code\":\"\\u003f\" }", root, false));
        REQUIRE(root["code"] == json::Value{"?"});

        // Test codepoints < 0x7ff
        REQUIRE(reader.parse("{ \"code\":\"\\u00fe\" }", root, false));
        REQUIRE(root["code"] == json::Value{"þ"});

        REQUIRE(reader.parse("{ \"code\":\"\\u07ee\" }", root, false));
        REQUIRE(root["code"] == json::Value{"߮"});

        REQUIRE(reader.parse("{ \"code\":\"\\u0111\" }", root, false));
        REQUIRE(root["code"] == json::Value{"đ"});

        // Test codepoints < 0xffff
        REQUIRE(reader.parse("{ \"code\":\"\\u2047\" }", root, false));
        REQUIRE(root["code"] == json::Value{"⁇"});

        REQUIRE(reader.parse("{ \"code\":\"\\u1234\" }", root, false));
        REQUIRE(root["code"] == json::Value{"ሴ"});

        REQUIRE(reader.parse("{ \"code\":\"\\ua1b2\" }", root, false));
        REQUIRE(root["code"] == json::Value{"ꆲ"});

        // Test codepoints < 0x10ffff
        // Seems like code is fixed to max 4 digits, see
        // Reader::decodeUnicodeEscapeSequence
        //  REQUIRE(reader.parse(R"({ "code":"\u10001" })", root, false));
        //  REQUIRE(root["code"] == ap::Utf8{u8"𐀁"});

        // REQUIRE(reader.parse(R"({ "code":"\u20000" })", root, false));
        // REQUIRE(root["code"] == ap::Utf8{u8"𠀀"});

        // REQUIRE(reader.parse(R"({ "code":"\u1000F" })", root, false));
        // REQUIRE(root["code"] == ap::Utf8{u8"𐀏"});
    }

    SECTION("Value to String") {
        auto compareStrs = [](const JSONCPP_STRING &left,
                              const JSONCPP_STRING &right) {
            auto epsilon = 0.01;
            return std::abs(_fs<double>(left) - _fs<double>(right)) < epsilon;
        };

        REQUIRE(json::valueToString(json::Int{-899}) == JSONCPP_STRING{"-899"});

        REQUIRE(json::valueToString(json::Int{895559}) ==
                JSONCPP_STRING{"895559"});

        REQUIRE(json::valueToString(json::Int{0}) == JSONCPP_STRING{"0"});

        REQUIRE_FALSE(json::valueToString(static_cast<json::UInt>(-899)) ==
                      JSONCPP_STRING{"-899"});

        REQUIRE(json::valueToString(json::UInt{895559}) ==
                JSONCPP_STRING{"895559"});

        REQUIRE(json::valueToString(json::UInt{0}) == JSONCPP_STRING{"0"});

        // Cannot compare directly to double string due to precision loss
        REQUIRE(
            compareStrs(json::valueToString(0.001), JSONCPP_STRING("0.001")));

        REQUIRE(compareStrs(json::valueToString(-20.005),
                            JSONCPP_STRING("-20.005")));

        REQUIRE(compareStrs(json::valueToString(890031.0000045),
                            JSONCPP_STRING("890031.0000045")));

        const char *oldLocale = setlocale(LC_NUMERIC, nullptr);

        const char *locale = "fr_FR";
        setlocale(LC_NUMERIC, locale);
        REQUIRE(
            compareStrs(json::valueToString(31.405), JSONCPP_STRING("31.405")));

        locale = "ru_RU";
        setlocale(LC_NUMERIC, locale);
        REQUIRE(
            compareStrs(json::valueToString(992.45), JSONCPP_STRING("992.45")));

        setlocale(LC_NUMERIC, oldLocale);

        if constexpr (std::numeric_limits<double>::is_iec559) {
            REQUIRE(
                json::valueToString(std::numeric_limits<double>::quiet_NaN()) ==
                JSONCPP_STRING("null"));

            REQUIRE(
                json::valueToString(std::numeric_limits<double>::infinity()) ==
                JSONCPP_STRING("1e+9999"));

            REQUIRE(
                json::valueToString(-std::numeric_limits<double>::infinity()) ==
                JSONCPP_STRING("-1e+9999"));
        }

        REQUIRE(json::valueToString(false) == JSONCPP_STRING("false"));

        REQUIRE(json::valueToString(true) == JSONCPP_STRING("true"));

        REQUIRE(json::valueToQuotedString(nullptr) == JSONCPP_STRING(""));

        REQUIRE(json::valueToQuotedString("Hello World") ==
                JSONCPP_STRING(R"("Hello World")"));

        REQUIRE(json::valueToQuotedString(R"("Hello World")") ==
                JSONCPP_STRING("\"\\\"Hello World\\\"\""));

        // Test escaped sequence variants
        {
            auto escSequenceChars =
                std::array{'\"', '\\', '\b', '\f', '\n', '\r', '\t'};
            auto expectedEscChars =
                std::array{'\"', '\\', 'b', 'f', 'n', 'r', 't'};
            for (size_t i = 0; i < escSequenceChars.size(); ++i) {
                auto escapeStr = std::string(1, escSequenceChars[i]);
                auto expectedEscapeStr = std::string(1, expectedEscChars[i]);
                auto normal = "Hello" + escapeStr + "World" + escapeStr;
                auto quoted = "\"Hello\\" + expectedEscapeStr + "World\\" +
                              expectedEscapeStr + "\"";
                REQUIRE(json::valueToQuotedString(normal.c_str()) ==
                        JSONCPP_STRING(quoted));
            }
        }

        // Test control characters
        {
            auto strWithCtrlChar = "Hello" + std::string(1, 2) + "World";
            auto quoted = R"("Hello\u0002World")";

            REQUIRE(json::valueToQuotedString(strWithCtrlChar.c_str()) ==
                    JSONCPP_STRING(quoted));
        }
    }
}
