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

TEST_CASE("file::Path") {
    SECTION("setFileExt") {
        REQUIRE(_ts(file::Path{"file/john/log.txt"}.setFileExt(".....log")) ==
                "file/john/log.log");
        REQUIRE(_ts(file::Path{"file/john/log.txt"}.setFileExt("log")) ==
                "file/john/log.log");
        REQUIRE(_ts(file::Path{"file/john/log.txt"}.setFileExt(".log")) ==
                "file/john/log.log");
    }

    SECTION("Relative leaf paths") {
        // The parent of a relative leaf path is null, i.e. invalid
        file::Path filename{"log.txt"};
        REQUIRE_FALSE(_ts(filename.parent()));
        REQUIRE_FALSE(filename.parent().valid());

        // The result of "empty / path" should be "path"
        REQUIRE(_ts(file::Path() / filename) == "log.txt");

        // setFileExt is const and invokes "path.parent() / new file name"; this
        // should yield "empty / path" for a leaf path
        REQUIRE(_ts(filename.setFileExt("test")) == "log.test");
    }

    SECTION("Relative non-leaf paths") {
        file::Path path{"file/john/log.txt"};
        REQUIRE(path.parent().valid());
        REQUIRE(_ts(path.parent()) == "file/john");

        REQUIRE(_ts(file::Path("stuff") / path) == "stuff/file/john/log.txt");
    }

    // Absolute paths (e.g. "/log.txt") are platform-specific; those tests are
    // in the platform path tests

    SECTION("unc") {
        // '//'-prefixed paths are UNC on all platforms
        file::Path genUncPath{"//server/share/file.txt"};
        REQUIRE(genUncPath);
        REQUIRE(genUncPath.isUnc());
        REQUIRE(genUncPath.valid());

        if constexpr (plat::IsWindows) {
            // '\\'-prefixed paths are also recognized as UNC on Windows
            file::Path winUncPath{"\\\\server\\share\\file.txt"};
            REQUIRE(winUncPath.isUnc());
            REQUIRE(winUncPath == genUncPath);
        }

        // The parent of "//server/share/file.txt" is "//server/share", which is
        // valid
        auto parent = genUncPath.parent();
        REQUIRE(parent);
        REQUIRE(parent.valid());

        // The parent of "//server/share" is just "//server", though, which is
        // not valid (missing share name)
        parent = parent.parent();
        REQUIRE_FALSE(parent);
        REQUIRE_FALSE(parent.valid());

        // The same should be true if we construct an invalid UNC path
        // explicitly
        _using(file::Path invalidUncPath{"//server"}) {
            REQUIRE_FALSE(invalidUncPath);
            REQUIRE_FALSE(invalidUncPath.valid());
        }

        _using(file::Path invalidUncPath{"//"}) {
            REQUIRE_FALSE(invalidUncPath);
            REQUIRE_FALSE(invalidUncPath.valid());
        }
    }

    SECTION("equality") { REQUIRE("C:/Users"_pth == "C:\\Users\\"_pth); }

    SECTION("sort <") { REQUIRE(!("C:/Users"_pth < "C:\\Users\\"_pth)); }

    SECTION("sort") {
        std::set<file::Path> paths;
        paths.insert("C:/Users");
        paths.insert("C:\\Users\\");
        REQUIRE(paths.size() == 1);
    }

    SECTION("isParentOf") {
        file::Path p1{"/this/that"};
        // Paths are both parent and child of themselves (i.e. an identical
        // path) if inclusive = true
        REQUIRE(p1.isParentOf(p1));
        REQUIRE(p1.isChildOf(p1));

        // And not if inclusive = false
        REQUIRE_FALSE(p1.isParentOf(p1, false));
        REQUIRE_FALSE(p1.isChildOf(p1, false));

        // Legitimate child path
        file::Path p2{"/this/that/other"};
        REQUIRE(p1.isParentOf(p2));
        REQUIRE(p2.isChildOf(p1));
        REQUIRE_FALSE(p2.isParentOf(p1));
        REQUIRE_FALSE(p1.isChildOf(p2));

        // Non-child path of same length
        file::Path p3{"/tom/dick/harry"};
        REQUIRE_FALSE(p1.isParentOf(p3));
        REQUIRE_FALSE(p1.isChildOf(p3));
        REQUIRE_FALSE(p3.isParentOf(p1));
        REQUIRE_FALSE(p3.isChildOf(p1));

        // Shorter non-child path
        file::Path p4{"/good"};
        REQUIRE_FALSE(p1.isParentOf(p4));
        REQUIRE_FALSE(p1.isChildOf(p4));
        REQUIRE_FALSE(p4.isParentOf(p1));
        REQUIRE_FALSE(p4.isChildOf(p1));

        // Longer non-child path
        file::Path p5{"/good/bad/and/ugly"};
        REQUIRE_FALSE(p1.isParentOf(p5));
        REQUIRE_FALSE(p1.isChildOf(p5));
        REQUIRE_FALSE(p5.isParentOf(p1));
        REQUIRE_FALSE(p5.isChildOf(p1));
    }

    SECTION("subpth") {
        auto p = "/john/smith"_pth;
        auto sp = p.subpth(1);
        REQUIRE(sp == "/smith"_pth);
    }

    SECTION("append") {
        const file::Path lhs = "this/that";
        const file::Path rhs = "the/other/thing";
        const file::Path expected = "this/that/the/other/thing";

        // Global operator /
        REQUIRE(lhs / rhs == expected);

        // operator /=
        _using(auto path = lhs) {
            path /= rhs;
            REQUIRE(path == expected);
        }

        // append
        _using(auto path = lhs) { REQUIRE(path.append(rhs) == expected); }
    }
}
