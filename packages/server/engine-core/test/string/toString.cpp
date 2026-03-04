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

struct WillFail {
    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        return APERR(Ec::InvalidParam, "Woops!");
    }
};

// Coverage for the tostring suite of apis
TEST_CASE("string::toString") {
    SECTION("Conversion error ") {
        Text buff;
        auto ccode = _tsbo(buff, {}, WillFail{});
        REQUIRE(ccode.code() == Ec::InvalidParam);
        REQUIRE(ccode.message().contains("Woops!"));
    }

    SECTION("No double append of delimiter") {
        auto res = _tsd<' '>("Hi ", " ", ' ', "there!");
        REQUIRE(res == "Hi   there!");

        res = _tsd<'*'>("Hi", "there!", '\n');
        REQUIRE(res == "Hi*there!\n");
    }

    SECTION("Delimiter flags") {
        auto res = _tsd<'*', Format::DOUBLE_DELIMOK>("Hi", "", "there!");
        REQUIRE(res == "Hi**there!");

        res = _tsd < '*',
        Format::LEAD | Format::DOUBLE_DELIMOK > ("Hi", "", "there!");
        REQUIRE(res == "*Hi**there!");

        res = _tsd < '*', Format::TRAIL | Format::LEAD |
                              Format::DOUBLE_DELIMOK > ("Hi", "", "there!");
        REQUIRE(res == "*Hi**there!*");
    }

    SECTION("convert") {
        REQUIRE(_ts("Hi", "There", "How", "Are", "You?") ==
                "HiThereHowAreYou?");
        REQUIRE(_ts(1, 2, 3, 4, 5) == "12345");
    }

    SECTION("convertWithDelimiter") {
        REQUIRE(_tsd<'-'>("Hi", "There", "How", "Are", "You?") ==
                "Hi-There-How-Are-You?");
        REQUIRE(_tsd<'-'>(1, 2, 3, 4, 5) == "1-2-3-4-5");
    }

    SECTION("convertTypes") {
        REQUIRE(_ts(Count(10'000)) == "10,000");
        REQUIRE(_ts(Count(100'000)) == "100,000");
        REQUIRE(_ts(uint16_t{10}, uint32_t{1}, uint64_t{5}) == "1015");
    }

    SECTION("convertVector") {
        auto numbers = std::vector<Size>{10_mb, 2_kb, 3_tb, 4_gb, 5_b};
        auto value = _ts(numbers);
        REQUIRE(value == "10MB 2kB 3TB 4GB 5B");
    }

    SECTION("convertMap") {
        auto numbers = std::map<Text, Count>{{"Red", 9}, {"Blue", 10'000}};
        auto value = _ts(numbers);
        REQUIRE(value == "Blue=10,000 Red=9");
    }

    SECTION("toStringShortAllocatorReplace") {
        StackTextArena arena;
        StackText line{arena};
        for (auto& str : {"lineone"_tv, "line2   "_tv, "line3"_tv}) {
            _tsb(line, str);
            REQUIRE(line == str);
        }
    }

    SECTION("convertPtr") {
        SECTION("Raw") {
            const auto literal = "Yo";
            auto value = _ts(literal);
            REQUIRE(value == "Yo");
        }

        SECTION("Shared") {
            REQUIRE(_ts(std::shared_ptr<Size>{}) == "{nullptr}");
            REQUIRE(_ts(std::make_shared<Size>(0)) == "0B");
        }

        SECTION("Weak") {
            auto ptr = std::make_shared<Size>(0);
            std::weak_ptr<Size> wPtr = ptr;
            REQUIRE(_ts(wPtr) == "0B");
            ptr.reset();
            REQUIRE(_ts(wPtr) == "{nullptr}");
        }

        SECTION("Unique") {
            REQUIRE(_ts(std::unique_ptr<Size>{}) == "{nullptr}");
            REQUIRE(_ts(std::make_unique<Size>(0)) == "0B");
        }

        SECTION("Optional") {
            REQUIRE(_ts(std::optional<Size>{}) == "");
            REQUIRE(_ts(std::optional<Size>(0)) == "0B");
        }
    }
}
