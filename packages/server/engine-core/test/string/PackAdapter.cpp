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

TEST_CASE("string::PackAdapter") {
    using namespace string;

    SECTION("vector") {
        std::vector<char> vector;

        auto adapter = PackAdapter{vector, 0};

        static_assert(PackAdapter<decltype(vector)>::HasReserve,
                      "Vector should have reserve");
        static_assert(PackAdapter<decltype(vector)>::HasSize,
                      "Vector should have size");

        REQUIRE(adapter.size() == 0);

        adapter.write("Hi there!");
        REQUIRE(vector.size() == 9);

        REQUIRE(adapter.toString() == "Hi there!");

        auto view = adapter.slice();
        REQUIRE(view.size() == 9);
        REQUIRE(memcmp(view.cast(), adapter.cast(), 9) == 0);

        vector.clear();

        REQUIRE(adapter.size() == 0);
    }

    SECTION("Data") {
        auto data = memory::Data<TextChr>(1_mb);
        auto adapter = PackAdapter{data, 0};
        REQUIRE(adapter.size() == 1_mb);
    }

    SECTION("DataView") {
        auto data = memory::Data<char>(1_mb);
        auto view = memory::DataView<char>{data};

        static_assert(PackAdapter<memory::DataView<char>>::IsDataView,
                      "Data view should be detected");
        static_assert(PackAdapter<memory::DataView<char>>::IsWriteable,
                      "Non const data view element should be writeable");
        static_assert(PackAdapter<memory::DataView<const char>>::IsConstElement,
                      "Const data view element should not be writeable");
        static_assert(!PackAdapter<memory::DataView<const char>>::IsWriteable,
                      "Const data view element should not be writeable");

        auto adapter = PackAdapter{view, 0};

        REQUIRE(adapter.size() == 1_mb);

        Txtcpy(data.cast(), 10, "Hi there!");
        auto str = Text{adapter.toString()};
        REQUIRE(str.startsWith("Hi there!"));

        auto view2 = adapter.slice();
        REQUIRE(view2.size() == 1_mb);
        REQUIRE(memcmp(view2.cast(), adapter.cast(), 1_mb) == 0);
    }

    SECTION("Text") {
        Text data = "Yo mama";
        auto adapter = PackAdapter{data, 0};

        static_assert(!PackAdapter<Text>::IsDataView,
                      "Text should be detected");
        static_assert(PackAdapter<Text>::HasResize, "Text have resize");
        static_assert(PackAdapter<Text>::HasReserve,
                      "Text should have reserve");
        static_assert(PackAdapter<Text>::IsWriteable,
                      "Text should be writeable");
        static_assert(PackAdapter<Text>::IsStringValue,
                      "Text should be string view");

        REQUIRE(adapter.size() == 7);
        REQUIRE(adapter.currentPos() == 0);

        auto view = adapter.toString();
        REQUIRE(view == "Yo mama");

        adapter.setPosition(7, 0);

        adapter << " wut u want";
        view = adapter.toString();
        REQUIRE(view == "Yo mama wut u want");
    }

    SECTION("TextView") {
        char data[] = "Hi there";
        TextView str(data);
        auto adapter = PackAdapter{str, 0};

        static_assert(!PackAdapter<TextView>::IsDataView,
                      "TextView should not be detected as data view");
        static_assert(!PackAdapter<TextView>::HasResize,
                      "TextView should not have resize");
        static_assert(!PackAdapter<TextView>::HasReserve,
                      "TextView should not have reserve");
        static_assert(!PackAdapter<TextView>::IsWriteable,
                      "TextViewView should not be writeable");
        static_assert(PackAdapter<TextView>::IsStringValue,
                      "TextViewView should be detected as string value");
        static_assert(PackAdapter<TextView>::IsStringView,
                      "TextViewView should be detected as string view");

        REQUIRE(adapter.size() == 8);
        REQUIRE(adapter.currentPos() == 0);

        auto view = adapter.toString();
        REQUIRE(view == "Hi there");
    }

    SECTION("std::array") {
        std::array<TextChr, 400> value = {};

        static_assert(
            PackAdapter<decltype(value)>::IsStringValue,
            "Data adapter should detect string value in std::array<TextChr...");
        static_assert(
            !PackAdapter<decltype(value)>::IsStringView,
            "Data adapter should detect string view in std::array<TextChr...");
    }
}
