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

static int g_moveCount;

struct MoveCheck {
    MoveCheck() = default;

    decltype(auto) operator=(MoveCheck&& mc) {
        REQUIRE(&mc != this);
        g_moveCount++;
        return *this;
    }

    MoveCheck(MoveCheck&& mc) { operator=(_mv(mc)); }

    MoveCheck(const MoveCheck&) = default;
};

TEST_CASE("ErrorOr") {
    SECTION("Arithmetic") {
        SECTION("Empty value/ccode throw") {
            ErrorOr<int> ec;
            auto scope = dev::bugCheckScope(false);
            auto ccode = _callChk([&] { ec.ccode(); });
            REQUIRE(ccode == Ec::Bug);
            ccode = _callChk([&] { ec.value(); });
            REQUIRE(ccode == Ec::Bug);
        }

        SECTION("Held value ccode throw") {
            ErrorOr<int> ec{1};
            auto scope = dev::bugCheckScope(false);
            REQUIRE(_callChk([&] { ec.ccode(); }) == Ec::Bug);
        }

        SECTION("Default construct") {
            ErrorOr<int> ec;
            REQUIRE(!ec.hasValue());
            REQUIRE(!ec.hasCcode());
            REQUIRE(!ec.check());
        }

        SECTION("Construct with value") {
            ErrorOr<int> ec{1};
            REQUIRE(ec.value() == 1);
            REQUIRE(ec.value() == 1);
            REQUIRE(!ec.check());
        }

        SECTION("Assign value") {
            ErrorOr<int> ec;
            ec = 1;
            REQUIRE(ec.value() == 1);
            REQUIRE(ec.hasValue());
            REQUIRE(!ec.hasCcode());
            REQUIRE(!ec.check());
        }

        SECTION("Variadic assign") {
            ErrorOr<uint64_t> ec1;
            ErrorOr<uint32_t> ec2;
            ec1 = 1234ul;
            ec2 = ec1;
            REQUIRE(ec2.value() == 1234);
        }
    }

    SECTION("Object") {
        SECTION("Implicit value move rvalue scope") {
            Function<MoveCheck()> fetch{[&] {
                ErrorOr<MoveCheck> ec{MoveCheck{}};
                g_moveCount = {};
                return ec;
            }};

            auto res = fetch();
            REQUIRE(g_moveCount);
        }

        SECTION("Variadic assign") {
            ErrorOr<Text> ec1;
            ErrorOr<TextView> ec2;
            ec1 = "Halllllloooo!"_t;
            ec2 = ec1;
            REQUIRE(ec2.value() == "Halllllloooo!"_tv);
        }
    }

    SECTION("Implicit ccode cast") {
        Function<Error()> fetch{[&]() -> Error {
            ErrorOr<MoveCheck> ec;
            ec = APERR(Ec::InvalidParam);
            return _cast<Error>(ec);
        }};

        auto ccode = fetch();
        REQUIRE(ccode == Ec::InvalidParam);
    }

    SECTION("Rethrow") {
        // Disable breaking into the debugger on Ec::Bug errors
        auto scope = dev::bugCheckScope(false);

        // ErorOr with error set should rethrow error
        _using(ErrorOr<Text> ec = APERR(Ec::InvalidParam)) {
            REQUIRE_THROWS_WITH(ec.rethrow(),
                                ContainsSubstring("InvalidParam"));
        }

        // ErrorOr with value set should throw "error not set" error
        _using(ErrorOr<Text> ec = Text("text")) {
            REQUIRE_THROWS_WITH(ec.rethrow(), ContainsSubstring("Bug"));
        }

        // Null ErrorOr should throw "error not set" error
        _using(ErrorOr<Text> ec) {
            REQUIRE_THROWS_WITH(ec.rethrow(), ContainsSubstring("Bug"));
        }
    }
}
