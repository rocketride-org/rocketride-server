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

TEST_CASE("string::format benchmark", "[.]") {
    SECTION("Render bench") {
        auto toString = [&] {
            uint64_t num = 123456789;
            auto str = _ts(num);
            ASSERTD(str == "123456789");
        };

        auto stdToString = [&] {
            uint64_t num = 123456789;
            auto str = std::to_string(num);
            ASSERTD(str == "123456789");
        };

        auto format = [&] {
            uint64_t value = 123456789;
            _const auto fmt = string::FormatStr<>("{,c}");
            auto str = string::formatEx(fmt, value);
            ASSERTD(str == "123,456,789");
        };

        auto stringStream = [&] {
            uint64_t value = 123456789;
            std::stringstream strm;
            strm << value;
            ASSERTD(strm.str() == "123456789");
        };

        auto bench =
            [&](std::function<void()> task) -> util::Throughput::Stats {
            util::Throughput rate;
            rate.start();
            auto start = time::now();
            while (time::now() - start < 10s) {
                task();
                rate.report();
            }
            rate.stop();
            return rate.stats();
        };

        auto toStringTask = std::async(std::launch::async, bench, toString);
        auto stdToStringTask =
            std::async(std::launch::async, bench, stdToString);
        auto formatTask = std::async(std::launch::async, bench, format);
        auto stringStreamTask =
            std::async(std::launch::async, bench, stringStream);

        toStringTask.wait();

        LOG(Test, "Number rendering bench results:");
        LOG(Test, "   string::toString: ", toStringTask.get());
        LOG(Test, "   std::to_string: ", stdToStringTask.get());
        LOG(Test, "   string::format: ", formatTask.get());
        LOG(Test, "   std::stringstream: ", stringStreamTask.get());
    }

    SECTION("Format bench") {
        SECTION("string::format constexpr") {
            auto start = time::now();
            util::Throughput rate;
            rate.start();
            _const auto fmt = string::FormatStr<4>("{,c}{,c}");
            while ((time::now() - start) < 10s) {
                Text result;
                auto ccode = string::formatEx(result, {}, fmt, 1234, 5678);
                REQUIRE(!ccode);
                REQUIRE(result == "1,2345,678");
                rate.report();
            }
            rate.stop();
            LOG(Test, "Format bench result for string::format:");
            LOG(Test, "   ", rate.stats());
        }
    }

    SECTION("Benchmark number parsing:") {
        auto fromChars = [&] {
            auto numStr = "123456789";
            uint64_t num;
            std::from_chars(numStr, numStr + Txtlen(numStr), num);
            ASSERTD(num == 123456789);
        };

        auto parseNumber = [&] {
            auto value = string::fromString<uint64_t>("123456789");
            ASSERTD(value == 123456789);
        };

        auto stringStream = [&] {
            uint64_t value;
            std::stringstream strm("123456789");
            strm >> value;
            ASSERTD(value == 123456789);
        };

        auto bench =
            [&](std::function<void()> task) -> util::Throughput::Stats {
            util::Throughput rate;
            rate.start();
            auto start = time::now();
            while (time::now() - start < 10s) {
                task();
                rate.report();
            }
            rate.stop();
            return rate.stats();
        };

        auto fromCharsTask = std::async(std::launch::async, bench, fromChars);
        auto parseNumberTask =
            std::async(std::launch::async, bench, parseNumber);
        auto stringStreamTask =
            std::async(std::launch::async, bench, stringStream);

        fromCharsTask.wait();

        LOG(Test, "Number parsing bench results:");
        LOG(Test, "   std::from_chars: ", fromCharsTask.get());
        LOG(Test, "   string::parseNumber: ", parseNumberTask.get());
        LOG(Test, "   std::stringstream: ", stringStreamTask.get());
    }
}
