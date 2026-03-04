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

TEST_CASE("ErrorOr and Dispatch") {
    auto myErrorOrMethod = [&](bool fail) -> ErrorOr<Text> {
        if (fail)
            return Error{Ec::End, _location, "Woops!"};
        else
            return Text{"Hooray!"};
    };

    auto verifyCcode = [&](Error ccode, ErrorCode expectedCode = Ec::End,
                           const Text &expectedMsg = "Woops!") {
        REQUIRE(ccode);
        REQUIRE(ccode.code() == expectedCode);
        REQUIRE(ccode.message() == expectedMsg);
    };

    auto verifyNotCalled = [&] { REQUIRE(!"Should not have been called!"); };

    auto verifyResult = [&](const Text &result) {
        REQUIRE(result == "Hooray!");
    };

    SECTION("Ccode returned - failure") {
        auto ccode = dispatch(
            [&](auto &&ccode) {
                verifyCcode(ccode);
                return ccode;
            },
            [&](auto &&result) { verifyNotCalled(); }, myErrorOrMethod(true));

        verifyCcode(ccode);
    }

    SECTION("Ccode not returned - failure") {
        auto ccode = dispatch([&](auto &&ccode) { verifyCcode(ccode); },
                              [&](auto &&result) { verifyNotCalled(); },
                              myErrorOrMethod(true));

        verifyCcode(ccode);
    }

    SECTION("Ccode changed on return - success") {
        auto ccode = dispatch([&](auto &&ccode) { verifyNotCalled(); },
                              [&](auto &&result) {
                                  verifyResult(result);
                                  return Error{Ec::AccessDenied, _location,
                                               "A New Error!"};
                              },
                              myErrorOrMethod(false));

        verifyCcode(ccode, Ec::AccessDenied, "A New Error!");
    }
}
