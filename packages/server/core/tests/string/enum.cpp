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

APUTIL_DEFINE_ENUM(Stuff, 0, 5, Foo = _begin, Bar,
                   Wut, /* string parse should ignore */
                   Hi,  // comments in enum
                   Hey);

struct Thing {
    APUTIL_DEFINE_ENUM_C(Stuff, 0, 5, Foo = _begin, Bar, Wut, Hi, Hey);
};

TEST_CASE("string::Enum") {
    SECTION("Global") {
        SECTION("fromString") {
            REQUIRE(_fs<Stuff>("foo") == Stuff::Foo);
            REQUIRE(_fs<Stuff>("FOO") == Stuff::Foo);
            REQUIRE(_fs<Stuff>("bar") == Stuff::Bar);
            REQUIRE(_fs<Stuff>("BAR") == Stuff::Bar);
            REQUIRE(_fs<Stuff>("wut") == Stuff::Wut);
            REQUIRE(_fs<Stuff>("WUT") == Stuff::Wut);
            REQUIRE(_fs<Stuff>("hi") == Stuff::Hi);
            REQUIRE(_fs<Stuff>("HI") == Stuff::Hi);
        }
        SECTION("toString") {
            REQUIRE(_ts(Stuff::Foo) == "Foo");
            REQUIRE(_ts(Stuff::Bar) == "Bar");
            REQUIRE(_ts(Stuff::Wut) == "Wut");
            REQUIRE(_ts(Stuff::Hi) == "Hi");
            REQUIRE(_ts(Stuff::Hey) == "Hey");
        }
    }

    SECTION("Class") {
        SECTION("fromString") {
            REQUIRE(_fs<Thing::Stuff>("foo") == Thing::Stuff::Foo);
            REQUIRE(_fs<Thing::Stuff>("FOO") == Thing::Stuff::Foo);
            REQUIRE(_fs<Thing::Stuff>("bar") == Thing::Stuff::Bar);
            REQUIRE(_fs<Thing::Stuff>("BAR") == Thing::Stuff::Bar);
            REQUIRE(_fs<Thing::Stuff>("wut") == Thing::Stuff::Wut);
            REQUIRE(_fs<Thing::Stuff>("WUT") == Thing::Stuff::Wut);
            REQUIRE(_fs<Thing::Stuff>("hi") == Thing::Stuff::Hi);
            REQUIRE(_fs<Thing::Stuff>("HI") == Thing::Stuff::Hi);
        }
        SECTION("toString") {
            REQUIRE(_ts(Thing::Stuff::Foo) == "Foo");
            REQUIRE(_ts(Thing::Stuff::Bar) == "Bar");
            REQUIRE(_ts(Thing::Stuff::Wut) == "Wut");
            REQUIRE(_ts(Thing::Stuff::Hi) == "Hi");
            REQUIRE(_ts(Thing::Stuff::Hey) == "Hey");
        }
    }

    SECTION("range") {
        SECTION("namespace") {
            std::array<Stuff, MaxStuffs> check = {
                Stuff::Foo, Stuff::Bar, Stuff::Wut, Stuff::Hi, Stuff::Hey};
            size_t index = 0;
            for (auto iter = begin(Stuff{}); iter != end(Stuff{});
                 ++iter, ++index) {
                REQUIRE(*iter == check[index]);
            }
        }
        SECTION("struct") {
            std::array<Thing::Stuff, Thing::MaxStuffs> check = {
                Thing::Stuff::Foo, Thing::Stuff::Bar, Thing::Stuff::Wut,
                Thing::Stuff::Hi, Thing::Stuff::Hey};
            size_t index = 0;
            for (auto iter = begin(Thing::Stuff{}); iter != end(Thing::Stuff{});
                 ++iter, ++index) {
                REQUIRE(*iter == check[index]);
            }
        }
    }
}
