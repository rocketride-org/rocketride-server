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

// Most cases here feed Location string literals, which is the ordinary way the class is
// used: it holds string_views so that constructing one costs no allocation, and that is
// only sound while the characters outlive every Error the location is copied into. A view
// over a caller-local string has no place in these tests because it has no place in the
// product - what it produces is undefined, not a result worth pinning.
//
// What is pinned below is the other half of that contract: a view is valid without being
// NUL-terminated, so fileName() must stop at the end of the view rather than read on to
// the next NUL in whatever buffer the view points into.
//
// Separators are platform-specific and the cases below are split accordingly: '/' divides
// a path everywhere, '\' only on Windows.

TEST_CASE("Location::fileName") {
    SECTION("an unset location has no file name") {
        ap::Location loc{};
        REQUIRE(!loc);
        REQUIRE(loc.fileName().empty());
    }

    SECTION("the directory is stripped") {
        ap::Location loc{"/usr/src/apLib/Location.hpp", 91, "fileName"};
        REQUIRE(loc.fileName() == "Location.hpp");
    }

    SECTION("a bare name is its own file name") {
        ap::Location loc{"Location.hpp", 1, "f"};
        REQUIRE(loc.fileName() == "Location.hpp");
    }

    SECTION("a trailing separator leaves no file name") {
        ap::Location loc{"/usr/src/apLib/", 1, "f"};
        REQUIRE(loc.fileName().empty());
    }

    SECTION("a lone separator leaves no file name") {
        ap::Location loc{"/", 1, "f"};
        REQUIRE(loc.fileName().empty());
    }

    SECTION("full path mode keeps the directory") {
        ap::Location loc{"/usr/src/apLib/Location.hpp", 91, "fileName", true};
        REQUIRE(loc.fileName() == "/usr/src/apLib/Location.hpp");
    }

    // The two cases below hold a view that is a prefix of a longer buffer, so the
    // character one past its end is 'a', not a NUL. Reading the path as a C string would
    // pick up the trailing words - and, in the general case, run off the allocation.
    SECTION("a view without a NUL after it stops at its own end") {
        const std::string buffer{"/usr/src/apLib/Location.hpp and more text"};
        const std::string_view path =
            std::string_view{buffer}.substr(0, buffer.find(' '));
        ap::Location loc{path, 91, "fileName"};
        REQUIRE(loc.fileName() == "Location.hpp");
    }

    SECTION("a view without a NUL after it stops at its own end in full path mode") {
        const std::string buffer{"/usr/src/apLib/Location.hpp and more text"};
        const std::string_view path =
            std::string_view{buffer}.substr(0, buffer.find(' '));
        ap::Location loc{path, 91, "fileName", true};
        REQUIRE(loc.fileName() == "/usr/src/apLib/Location.hpp");
    }

#if ROCKETRIDE_PLAT_WIN
    SECTION("a backslash divides a path on Windows") {
        ap::Location loc{"E:\\dev\\apLib\\Location.hpp", 91, "fileName"};
        REQUIRE(loc.fileName() == "Location.hpp");
    }

    SECTION("mixed separators split on the last one") {
        ap::Location loc{"E:\\dev/apLib\\Location.hpp", 1, "f"};
        REQUIRE(loc.fileName() == "Location.hpp");
    }

    // A drive with no separator after it: "C:Location.hpp" names a file relative to the
    // current directory *of drive C*, so the drive is part of the path and not of the name.
    SECTION("a drive-relative path keeps only the name") {
        ap::Location loc{"C:Location.hpp", 1, "f"};
        REQUIRE(loc.fileName() == "Location.hpp");
    }
#endif
}

TEST_CASE("Location accessors") {
    SECTION("line and function are returned as given") {
        ap::Location loc{"/usr/src/apLib/Location.hpp", 91, "fileName"};
        REQUIRE(loc.line() == 91);
        REQUIRE(loc.function() == "fileName");
    }

    SECTION("an unset location is false, a set one is true") {
        REQUIRE(!ap::Location{});
        REQUIRE(ap::Location{"a.cpp", 1, "f"});
    }

    SECTION("locations compare on all three fields") {
        const ap::Location loc{"a.cpp", 1, "f"};
        REQUIRE(loc == ap::Location{"a.cpp", 1, "f"});
        REQUIRE(loc != ap::Location{"a.cpp", 2, "f"});
        REQUIRE(loc != ap::Location{"b.cpp", 1, "f"});
        REQUIRE(loc != ap::Location{"a.cpp", 1, "g"});
    }

    // Ordering exists so a location can key a container: same file sorts by line.
    SECTION("ordering groups by path then line") {
        REQUIRE(ap::Location{"a.cpp", 1, "f"} < ap::Location{"a.cpp", 2, "f"});
        REQUIRE(ap::Location{"a.cpp", 9, "f"} < ap::Location{"b.cpp", 1, "f"});
        REQUIRE(!(ap::Location{"a.cpp", 2, "f"} < ap::Location{"a.cpp", 1, "f"}));
    }
}

TEST_CASE("Location::operator||") {
    const ap::Location caller{"caller.cpp", 10, "caller"};
    const ap::Location callee{"callee.cpp", 20, "callee"};

    SECTION("a set right-hand side wins") {
        REQUIRE((caller || callee) == callee);
    }

    SECTION("an unset right-hand side leaves the left in place") {
        REQUIRE((caller || ap::Location{}) == caller);
    }

    SECTION("two unset locations stay unset") {
        REQUIRE(!(ap::Location{} || ap::Location{}));
    }
}

TEST_CASE("Location::sanitizeFunctionName") {
    SECTION("an ordinary name is left alone") {
        REQUIRE(ap::Location::sanitizeFunctionName("fileName") == "fileName");
    }

    // Lambda type names are long, unstable and useless in a log line, so everything from
    // the '<' onwards collapses to a marker.
    SECTION("a lambda collapses to a marker") {
        REQUIRE(ap::Location::sanitizeFunctionName("pybind11_init::<lambda_96>::operator()") ==
                "pybind11_init::[lambda]");
    }

    SECTION("an unclosed angle bracket is not a lambda") {
        REQUIRE(ap::Location::sanitizeFunctionName("operator<") == "operator<");
    }

    SECTION("an empty name stays empty") {
        REQUIRE(ap::Location::sanitizeFunctionName("").empty());
    }
}

TEST_CASE("Location::toString") {
    const ap::Location loc{"/usr/src/apLib/Location.hpp", 91, "fileName"};

    // Count groups digits, so a line past 999 is not rendered as bare digits.
    SECTION("a line number past 999 is grouped") {
        const ap::Location deepLoc{"services.cpp", 2047, "run"};
        Text buff;
        deepLoc.toString(buff, true, true);
        REQUIRE(buff == "services.cpp:2,047-run");
    }

    SECTION("file and function together") {
        Text buff;
        loc.toString(buff, true, true);
        REQUIRE(buff == "Location.hpp:91-fileName");
    }

    SECTION("the defaults render the file only") {
        Text buff;
        loc.toString(buff);
        REQUIRE(buff == "Location.hpp:91");
    }

    SECTION("file only") {
        Text buff;
    SECTION("the defaults render the file only") {
        Text buff;
        loc.toString(buff);
        REQUIRE(buff == "Location.hpp:91");
    }

    SECTION("file only") {
        Text buff;
        loc.toString(buff, false, true);
        REQUIRE(buff == "Location.hpp:91");
    }
        REQUIRE(buff == "Location.hpp:91");
    }

    SECTION("function only") {
        Text buff;
        loc.toString(buff, true, false);
        REQUIRE(buff == "fileName");
    }

    SECTION("neither file nor function renders nothing") {
        Text buff;
        loc.toString(buff, false, false);
        REQUIRE(buff.empty());
    }

    SECTION("an unset location renders the separator and a zero line") {
        Text buff;
        ap::Location{}.toString(buff, false, true);
        REQUIRE(buff == ":0");
    }
        Text buff;
        loc.toString(buff, false, false);
        REQUIRE(buff.empty());
    }

    SECTION("an unset location reaches toString via the unguarded pack API shape") {
        const ap::Location unsetLoc{};
        Text buff;
        unsetLoc.toString(buff, false);
        REQUIRE(buff == ":0");
    }

    SECTION("full path mode keeps the directory") {
        const ap::Location fullPathLoc{"/usr/src/apLib/Location.hpp", 91, "fileName", true};
        Text buff;
        fullPathLoc.toString(buff, true, true);
        REQUIRE(buff == "/usr/src/apLib/Location.hpp:91-fileName");
    }

    SECTION("a lambda function name is sanitized in the rendered output") {
        const ap::Location lambdaLoc{"a.cpp", 1, "pybind11_init::<lambda_96>::operator()"};
        Text buff;
        lambdaLoc.toString(buff, true, false);
        REQUIRE(buff == "pybind11_init::[lambda]");
    }

    SECTION("a line number past 999 is grouped") {
        const ap::Location deepLoc{"services.cpp", 2047, "run"};
        Text buff;
        deepLoc.toString(buff, true, true);
        REQUIRE(buff == "services.cpp:2,047-run");
    }
}