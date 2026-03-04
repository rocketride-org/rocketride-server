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

TEST_CASE("file::UnxPath") {
    SECTION("Parent") {
        auto path = "\\john\\smith"_pth;
        REQUIRE(path.prefix() == "/");
        REQUIRE(path.count() == 2);
        REQUIRE(path.isAbsolute());
        REQUIRE(!path.isRelative());
        REQUIRE(path == "\\john\\smith");
        REQUIRE(path == "/john/smith");
        REQUIRE(path != "\\John\\smith");
        REQUIRE(path != "/John/smith");
        REQUIRE(path.plat(true) == "/john/smith");
        REQUIRE(path.plat(false) == "/john/smith");
        REQUIRE(_cast<Text>(path) == "/john/smith");
        REQUIRE(_cast<TextView>(path) == "/john/smith");
        REQUIRE(path.prefix() == "/");
        auto res = path.parent();
        REQUIRE(res == "/john");
        auto res2 = res.parent();
        auto val = res2 == "/";
        REQUIRE(val);
        REQUIRE(path.parent().parent().parent() == "/");

        SECTION("Absolute leaf paths") {
            // The parent of an absolute leaf path is absolute but empty
            file::Path path{"/log.txt"};
            REQUIRE(path.parent().type() == file::PathType::ABSOLUTE);
            REQUIRE(_ts(path.parent()) == "/");

            // Joining the empty absolute path with a relative path should yield
            // a new absolute path
            REQUIRE(_ts(path.parent() / "new.txt") == "/new.txt");

            // Joining anything with an absolute path yields the absolute path
            // Here's a test case using the Standard Library:
            std::filesystem::path stdPath1("/bar.txt");
            std::filesystem::path stdPath2("/foo.txt");
            std::filesystem::path joined = stdPath1 / stdPath2;
            REQUIRE(joined == stdPath2);
            REQUIRE(joined.string() == "/foo.txt");

            // Now with ap::file::Path
            REQUIRE(_ts(file::Path("stuff") / path) == "stuff/log.txt");
            REQUIRE(_ts(file::Path("/stuff") / path) == "/stuff/log.txt");

            REQUIRE(_ts(path.setFileExt("test")) == "/log.test");
        }

        SECTION("Absolute non-leaf paths") {
            file::Path path{"/file/john/log.txt"};
            REQUIRE(path.parent().type() == file::PathType::ABSOLUTE);
            REQUIRE(_ts(path.parent()) == "/file/john");

            REQUIRE(_ts(path.setFileExt("test")) == "/file/john/log.test");
        }
    }

    SECTION("Operator /") {
        auto path = "/john/smith"_pth;
        auto path2 = path / "bobo";
        REQUIRE(path2 == "/john/smith/bobo");
        REQUIRE(path2 / "frodo" == "/john/smith/bobo/frodo");

        auto path3 = path / "bobo/frodo/mobo\\yada";
        REQUIRE(path3 == "/john/smith/bobo/frodo/mobo/yada");
        REQUIRE(path3.count() == 6);

        auto path4 = "/"_pth / "*";
        REQUIRE(path4 == "/*");
    }

    SECTION("Relative") {
        REQUIRE(file::Path{"/"}.isAbsolute());
        REQUIRE(file::Path{"\\"}.isAbsolute());

        REQUIRE(file::Path{"john"}.isRelative());
        REQUIRE(file::Path{"john"}.isRelative());

        REQUIRE(file::Path{"./"}.isRelative());
        REQUIRE(file::Path{"./john"}.isRelative());
        REQUIRE(file::Path{"./john"}.isRelative());

        REQUIRE(file::Path{"~/"}.isAbsolute());
        REQUIRE(file::Path{"~/john"}.isAbsolute());
        REQUIRE(!file::Path{"~/john"}.isRelative());
        REQUIRE(file::Path{"~/john"}.prefix() == "~/");
        REQUIRE(!file::Path{"./john"}.fileExt());

        REQUIRE(file::Path{"./john.txt"}.isRelative());
        REQUIRE(file::Path{"./john.txt"}.isRelative());
        REQUIRE(file::Path{"./john.txt"}.prefix() == "./");
        REQUIRE(file::Path{"./john.txt"}.fileName() == "john.txt");
        REQUIRE(file::Path{"./john.txt"}.fileExt() == "txt");
    }

    SECTION("Weird") {
        REQUIRE(file::Path{"|:"}.valid() == true);
        REQUIRE(file::Path{"|:"}.count() == 1);
        REQUIRE(file::Path{"|:"}[0] == "|:");
    }

    SECTION("Empty/Prefix") {
        file::Path path{"/home/john/bobo"};

        for (auto i = 0; i < 3; i++) {
            switch (i) {
                case 0:
                    REQUIRE(path.count() == 3);
                    REQUIRE(path);
                    break;
                case 1:
                    REQUIRE(path.count() == 2);
                    REQUIRE(path);
                    break;
                case 2:
                    REQUIRE(path.count() == 1);
                    REQUIRE(path);
                    break;
            }
            path = path.parent();
        }

        REQUIRE(path);
        REQUIRE(path.count() == 0);
        REQUIRE(path.prefix() == "/");
    }
}
