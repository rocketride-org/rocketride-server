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

TEST_CASE("log::Colors") {
    SECTION("LOG") {
        for (auto c : Color{}) LOG(Test, c, colorName(c));
    }

    SECTION("Conversion from string") {
        for (auto c : Color{}) {
            REQUIRE(_fs<Color>(colorName(c)) == c);
            REQUIRE(_fs<Color>(iText{colorName(c)}.lowerCase()) == c);
            REQUIRE(_fs<Color>(iText{colorName(c)}.upperCase()) == c);
        }
        REQUIRE(_fsc<Color>("invalid").hasCcode());
    }

    SECTION("Invalid --log.decorationColor keeps default on init") {
        auto savedCmdLine = application::cmdline();
        auto savedColor = log::options().decorationColor;
        auto savedIsAtty = log::options().isAtty;
        auto savedDisableAllColors = log::options().disableAllColors;

        log::options().decorationColor = Color::Green;
        application::cmdline().addArg("--log.decorationColor=invalid");
        application::Options::get().init();
        log::init();

        REQUIRE(log::options().decorationColor == Color::Green);

        application::cmdline().addArg("--log.decorationColor=");
        application::Options::get().init();
        application::cmdline() = savedCmdLine;
        log::options().decorationColor = savedColor;
        log::options().isAtty = savedIsAtty;
        log::options().disableAllColors = savedDisableAllColors;
    }
}
