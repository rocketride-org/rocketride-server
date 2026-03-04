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

TEST_CASE("Error") {
    SECTION("OS code compare") {
#if ROCKETRIDE_PLAT_WIN
        auto ccode = APERR(ERROR_FILE_NOT_FOUND);
        REQUIRE(ccode == ERROR_FILE_NOT_FOUND);
#else
        auto ccode = APERR(EINVAL);
        REQUIRE(ccode == EINVAL);
#endif
    }

    SECTION("Ec code compare") {
        auto ccode = APERR(Ec::NotFound);
        REQUIRE(ccode == Ec::NotFound);
        REQUIRE(ccode != EnumIndex(Ec::NotFound));
    }

    SECTION("Ec code compare") {
        auto ccode = APERR(Ec::NotFound);
        auto ccode_loc = ccode.location();
        REQUIRE(ccode_loc);
        auto ccode2 = _mv(ccode);
        auto ccode2_loc = ccode2.location();
        REQUIRE(ccode2_loc);
        REQUIRE(ccode_loc == ccode2_loc);
    }

    SECTION("Chain") {
        auto first = APERR(Ec::NotFound, "Not Found");
        auto second = APERR(first, "Invalid Param");
        LOG(Test, "Made chain", second);
        REQUIRE(second.message().contains("Invalid Param"));
        REQUIRE(!second.message().contains("Not Found"));
        REQUIRE(second.root().message().contains("Not Found"));
        REQUIRE(!second.root().message().contains("Invalid Param"));
    }

    SECTION("Equality") {
        ASSERTD(APERR(Ec::NotFound) != APERR(Ec::InvalidParam));
        ASSERTD(APERR(Ec::NotFound) == APERR(Ec::NotFound));
    }

    SECTION("Logical operators") {
        Error error = APERR(Ec::NotFound, "Not Found");
        REQUIRE((error || Error()));
        REQUIRE((Error() || error));
        REQUIRE((error || error));
        REQUIRE_FALSE((Error() || Error()));

        Error orEq = error;
        orEq |= Error();
        REQUIRE(orEq == error);
        orEq |= error;
        REQUIRE(orEq == error);

        orEq = Error();
        orEq |= Error();
        REQUIRE_FALSE(orEq);
        orEq |= error;
        REQUIRE(error);
    }

    SECTION("Rethrow") {
        // Disable breaking into the debugger on Ec::Bug errors
        auto scope = dev::bugCheckScope(false);

        // ErorOr with error set should rethrow error
        _using(Error ec = APERR(Ec::InvalidParam)) {
            REQUIRE_THROWS_WITH(ec.rethrow(),
                                ContainsSubstring("InvalidParam"));
        }

        // Null ErrorOr should throw "error not set" error
        _using(Error ec) {
            REQUIRE_THROWS_WITH(ec.rethrow(), ContainsSubstring("Bug"));
        }
    }
}
