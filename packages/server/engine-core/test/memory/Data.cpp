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

TEST_CASE("memory::Data") {
    SECTION("Data") {
        memory::Data<TextChr> data(1_mb);
        memory::Data<TextChr> data2(1_mb);
        REQUIRE(data.size() == 1_mb);
        memset(data.cast(), 0, 1_mb);
        memset(data2.cast(), 1, 1_mb);
        REQUIRE(memcmp(data.cast(), data2.cast(), 1_mb) != 0);
        memset(data2.cast(), 0, 1_mb);
        REQUIRE(memcmp(data.cast(), data2.cast(), 1_mb) == 0);

        SECTION("DataView from Data") {
            auto view = memory::DataView<TextChr>{data};
            auto view2 = memory::DataView<TextChr>{data2};

            REQUIRE(view.size() == 1_mb);
            memset(view.cast(), 0, 1_mb);
            memset(view2.cast(), 1, 1_mb);
            REQUIRE(memcmp(view.cast(), view2.cast(), 1_mb) != 0);
            memset(view2.cast(), 0, 1_mb);
            REQUIRE(memcmp(view.cast(), view2.cast(), 1_mb) == 0);
        }
    }

    SECTION("DataView") {
        SECTION("std::vector<char>") {
            std::vector<char> stuff = {'a', 'b', 'c', 'd'};

            memory::DataView<char> proxy(stuff);

            REQUIRE(proxy.at(0) == 'a');
            REQUIRE(proxy.at(1) == 'b');
            REQUIRE(proxy.at(2) == 'c');
            REQUIRE(proxy.at(3) == 'd');

            stuff[0] = 'g';

            REQUIRE(proxy.at(0) == 'g');
        }

        SECTION("string::Str<uint32_t>") {
            string::Str<uint32_t> str = {1000, 1023, 8812};
            memory::DataView<uint32_t> proxy(str);

            REQUIRE(proxy.at(0) == 1000);
            REQUIRE(proxy.at(1) == 1023);
            REQUIRE(proxy.at(2) == 8812);

            str[0] = 999;

            REQUIRE(proxy.at(0) == 999);

            SECTION("string::Str<uint32_t> (sliced)") {
                auto sliced = proxy.sliceAt(1);
                REQUIRE(sliced.at(0) == 1023);
                REQUIRE(sliced.at(1) == 8812);
            }
        }

        SECTION("Slice copy") {
            std::array<char, 512> data;
            std::fill(data.begin(), data.begin() + 256, 'A');
            std::fill(data.begin() + 256, data.end(), 'B');
            memory::DataView<char> proxy(data);

            auto slice1 = proxy.sliceAt(0, 256);
            auto slice2 = proxy.sliceAt(256);

            REQUIRE(slice1.size() == 256);
            REQUIRE(slice2.size() == 256);

            REQUIRE(util::allOf(slice1, [](auto& chr) { return chr == 'A'; }));
            REQUIRE(util::allOf(slice2, [](auto& chr) { return chr == 'B'; }));

            std::fill(slice1.begin(), slice1.end(), 'C');
            std::fill(slice2.begin(), slice2.end(), 'D');

            REQUIRE(util::allOf(slice1, [](auto& chr) { return chr == 'C'; }));
            REQUIRE(util::allOf(slice2, [](auto& chr) { return chr == 'D'; }));

            REQUIRE(std::all_of(data.begin(), data.begin() + 256,
                                [](auto chr) { return chr == 'C'; }));
            REQUIRE(std::all_of(data.begin() + 256, data.end(),
                                [](auto chr) { return chr == 'D'; }));
        }

        SECTION("Deductions") {
            SECTION("TextView") {
                auto view2 = memory::DataView("Hi there!"_tv);
                REQUIRE(view2 == "Hi there!"_tv);
            }
            SECTION("iTextView") {
                auto view2 = memory::DataView(iTextView{"Hi there!"});
                REQUIRE(view2 == "Hi there!"_tv);
            }
            SECTION("Text") {
                Text data = "Hi there!";
                auto view2 = memory::DataView{data};
                REQUIRE(view2 == "Hi there!"_tv);
            }
            SECTION("iText") {
                iText data = "Hi there!";
                auto view2 = memory::DataView(data);
                REQUIRE(view2 == "Hi there!"_tv);
            }
#if ROCKETRIDE_PLAT_WIN
            SECTION("Utf16") {
                Utf16 data = L"Hi there!";
                auto view2 = memory::DataView(data);
                REQUIRE(view2 == L"Hi there!"_tv);
            }
#endif
            SECTION("Array") {
                std::array data{'H', 'i', ' ', 't', 'h', 'e', 'r', 'e', '!'};
                auto view = memory::DataView(data);
                REQUIRE(view == "Hi there!"_tv);
            }
        }

        SECTION("Logging") {
            Buffer data;
            data.resize(1024);
            LOG(Test, "Printing random", data);
            for (auto& chr : data) {
                chr = 'a';
            }
            LOG(Test, "Printing a", data);
        }
    }
}
