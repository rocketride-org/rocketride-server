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

TEST_CASE("util::Vars") {
    SECTION("JSON expand") {
        util::Vars vars;
        vars.add("includepath", "c:/");
        vars.add("anotherincludepath", "D:/");
        vars.add("YetAnotherIncludePath", "E:/");

        auto res = *json::parse(R"(
				{
					"command": "scan",
					"config": {
						"includePaths": [
							"%IncludePath%",
							"%AnotherIncludePath%",
							"%YetAnotherIncludePath%"
						],
						"output": "dataNet://scan/data/scan?host=10.0.0.81&port=9745"
					}
				}
			)");
        res.expandTree(vars);

        REQUIRE(res["config"]["includePaths"].size() == 3);
        REQUIRE(res["config"]["includePaths"][0] == "c:/");
        REQUIRE(res["config"]["includePaths"][1] == "D:/");
        REQUIRE(res["config"]["includePaths"][2] == "E:/");
    }

    SECTION("Escaped") {
        util::Vars vars;
        vars.add("var", "replaced");

        REQUIRE(vars.expand("%var%") == "replaced");
        REQUIRE(vars.expand(R"(text\%var%)") == R"(text\replaced)");
        REQUIRE(vars.expand(R"(\%var%)") == R"(\replaced)");
        REQUIRE(vars.expand(R"(\\%var%)") == R"(\\replaced)");
        REQUIRE(vars.expand(R"(\\\%var%)") == R"(\\\replaced)");
        REQUIRE(vars.expand(R"(\\\\%var%)") == R"(\\\\replaced)");
        REQUIRE(vars.expand(R"(%var%\)") == R"(replaced\)");

        // the same as above, but with `%var` instead of `%var%
        REQUIRE(vars.expand("%var") == "%var");
        REQUIRE(vars.expand(R"(text\%var)") == R"(text\%var)");
        REQUIRE(vars.expand(R"(\%var)") == R"(\%var)");
        REQUIRE(vars.expand(R"(\\%var)") == R"(\\%var)");
        REQUIRE(vars.expand(R"(\\\%var)") == R"(\\\%var)");
        REQUIRE(vars.expand(R"(\\\\%var)") == R"(\\\\%var)");
        REQUIRE(vars.expand(R"(%var\)") == R"(%var\)");
    }

    SECTION("MultipleDelims") {
        util::Vars vars;
        vars.add("var", " replaced ");

        REQUIRE(vars.expand("foo%%%var%bar") == "foo% replaced bar");
        REQUIRE(vars.expand("foo%var%%%bar") == "foo replaced %bar");
        REQUIRE(vars.expand("foo%var%%bar") == "foo replaced %bar");
        REQUIRE(vars.expand("foo%%%var%%%bar") == "foo% replaced %bar");
    }

    SECTION("BackToBackVars") {
        util::Vars vars;
        vars.add("var", " replaced ");
        vars.add("cat", "bingo ");

        // Back to back vars share a %
        REQUIRE(vars.expand("foo%var%cat%dog") == "foo replaced cat%dog");

        // Back to back vars have their own %
        REQUIRE(vars.expand("foo%var%%cat%dog") == "foo replaced bingo dog");
    }

    SECTION("NoRecursion") {
        util::Vars vars;
        vars.add("cat", "bingo");
        vars.add("mouse", "at%");
        vars.add("dog", "hog%");

        // Replacement would cause previous % to begin an alias
        REQUIRE(vars.expand("%c%mouse%") == "%cat%");

        // Replacement would cause next % to end an alias
        REQUIRE(vars.expand("foo%dog%cat%") == "foohog%cat%");
    }

    SECTION("NotAllPercentsAreVars") {
        util::Vars vars;

        // Not all %-wrapped strings are aliases
        vars.add("foo", "rock ");
        vars.add("cat", " stone ");
        REQUIRE(vars.expand("%foo%bar%var%cat%dog%mouse%") ==
                "rock bar%var stone dog%mouse%");
    }
}
