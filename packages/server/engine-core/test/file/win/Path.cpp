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

TEST_CASE("file::WinPath") {
    SECTION("Equality") {
        REQUIRE("c:/john/smith/"_pth == "C:/jOhn/Smith");
        REQUIRE("c:/john/smith/"_pth == "C:/jOhn/Smith"_tv);
        REQUIRE("c:/john/smith/"_pth == "C:/jOhn/Smith"_pth);
    }

    SECTION("Parent") {
        auto path = "c:\\john\\smith"_pth;
        REQUIRE(path.count() == 3);
        REQUIRE(path.isAbsolute());
        REQUIRE(!path.isRelative());
        REQUIRE(!path.isUnc());
        REQUIRE(path == "C:\\JOHN\\SMITH");
        REQUIRE(path == "c:/JOHN/smith");
        REQUIRE(path.gen() == "c:/john/smith");
        REQUIRE(path.plat(true) == "\\\\?\\c:\\john\\smith");
        REQUIRE(path.plat(false) == "c:\\john\\smith");
        REQUIRE(_cast<Text>(path) == "C:/john/smith");
        REQUIRE(_cast<TextView>(path) == "C:/john/smith");
        REQUIRE(path.parent() == "c:/john");
        REQUIRE(path.parent().parent() == "c:");
        REQUIRE(path.parent().parent().parent() == "");

        SECTION("Absolute non-leaf paths") {
            file::Path path{"C:/file/john/log.txt"};
            REQUIRE(path.parent().type() == file::PathType::ABSOLUTE);
            REQUIRE(_ts(path.parent()) == "C:/file/john");

            // Joining them should retain the attributes even if the right is
            // relative the left being absolute/relative carries that around
            auto rl = "stuff"_pth;
            REQUIRE(rl.isRelative() == true);
            auto rl2 = rl / path;
            REQUIRE(rl2.isRelative() == true);

            REQUIRE(_ts(path.setFileExt("test")) == "C:/file/john/log.test");
        }
    }

    SECTION("Conversion (Utf16)") {
        auto path = L"c:/john/smith"_pth;
        REQUIRE(path == "c:/john/smith"_tv);
        REQUIRE(path == "c:/john/smith"_t);
        REQUIRE(path == "c:/john/smith");
        REQUIRE(!Utf16cmp(_cast<const Utf16Chr *>(path), L"C:/john/smith"));
    }

    SECTION("Operator /") {
        file::Path path = "C:/test";
        file::Path joined = path / "log.txt";
        REQUIRE(_ts(joined) == "C:/test/log.txt");
    }

    SECTION("Operator / (Utf16)") {
        auto path = L"c:/john/smith"_pth;
        auto path2 = path / "bobo";
        REQUIRE(path2 == "c:/john/smith/bobo");
        REQUIRE(path2 / "frodo" == "c:/john/smith/bobo/frodo");

        auto path3 = path / "bobo/frodo/mobo\\yada";
        REQUIRE(path3 == "c:/john/smith/bobo/frodo/mobo/yada");
        REQUIRE(path3.count() == 7);
    }

    SECTION("Prefix") {
        SECTION("Long") {
            auto path = R"(\\?\c:\john\smith)"_pth;
            REQUIRE(path == "c:/john/smith");
            REQUIRE(path.isAbsolute());
            REQUIRE(path.plat(true) == R"(\\?\c:\john\smith)");
            REQUIRE(path.plat(false) == R"(c:\john\smith)");
            REQUIRE(path.platLongTrailingSep() == R"(\\?\c:\john\smith\)");
            REQUIRE(path.platTrailingSep() == R"(\\?\c:\john\smith\)");
            REQUIRE(path.platTrailingSep(false) == R"(c:\john\smith\)");
        }

        SECTION("Share") {
            auto path = R"(\\192.168.0.1\bobo)"_pth;
            REQUIRE(path == "//192.168.0.1/bobo");
            REQUIRE(path == "\\\\192.168.0.1\\bobo");
            REQUIRE(path.isUnc());
            REQUIRE(path.isAbsolute());
            REQUIRE(path.plat(true) == R"(\\?\UNC\192.168.0.1\bobo)");
            REQUIRE(path.plat(false) == R"(\\192.168.0.1\bobo)");
        }

        SECTION("UNC") {
            auto path = R"(\\UNC\192.168.0.1\bobo)"_pth;
            REQUIRE(path == "//192.168.0.1/bobo");
            REQUIRE(path == "\\\\192.168.0.1\\bobo");
            REQUIRE(path.isUnc());
            REQUIRE(path.isAbsolute());
            REQUIRE(path.plat(true) == R"(\\?\UNC\192.168.0.1\bobo)");
            REQUIRE(path.plat(false) == R"(\\192.168.0.1\bobo)");
        }

        SECTION("UNC Long") {
            auto path = R"(\\?\UNC\192.168.0.1\bobo)"_pth;
            REQUIRE(path == "//192.168.0.1/bobo");
            REQUIRE(path == "\\\\192.168.0.1\\bobo");
            REQUIRE(path.isUnc());
            REQUIRE(path.plat(true) == R"(\\?\UNC\192.168.0.1\bobo)");
            REQUIRE(path.plat(false) == R"(\\192.168.0.1\bobo)");
        }
    }

    SECTION("Snapshot") {
        auto path = R"(GLOBALROOT/Device/HarddiskVolumeShadowCopy86)"_pth;
        REQUIRE(path.isSnap());
        REQUIRE(path.isAbsolute());
        REQUIRE(!path.isUnc());
        REQUIRE(path.count() == 3);
        REQUIRE(path[0] == "GLOBALROOT");
        REQUIRE(path[1] == "Device");
        REQUIRE(path[2] == "HarddiskVolumeShadowCopy86");
    }

    SECTION("Volume Guid") {
        auto path = R"(\\?\Volume{1234}\windows\system32)"_pth;
        LOG(Test, "Gen:", path.gen());
        REQUIRE(!path.isSnap());
        REQUIRE(path.isAbsolute());
        REQUIRE(!path.isUnc());
        REQUIRE(path.count() == 3);
        REQUIRE(path[0] == "vOLUME{1234}");
        REQUIRE(path[1] == "winDOWS");
        REQUIRE(path[2] == "SysTem32");
    }

    SECTION("Relative") {
        REQUIRE(file::Path{"/"}.isAbsolute());
        REQUIRE(file::Path{"\\"}.isAbsolute());

        REQUIRE(file::Path{"john"}.isRelative());
        REQUIRE(file::Path{"john"}.isRelative());

        REQUIRE(file::Path{"./john"}.isRelative());
        REQUIRE(file::Path{"./john"}.isRelative());

        REQUIRE(file::Path{"./john.txt"}.isRelative());
        REQUIRE(file::Path{"./john.txt"}.isRelative());
    }

    SECTION("Invalid") { REQUIRE(file::Path{"|:"}.valid() == false); }

    SECTION("Empty/Prefix") {
        auto path = R"(\\?\Volume{1234}\windows\system32)"_pth;
        REQUIRE(path);

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

        REQUIRE(!path);
        REQUIRE(path.count() == 0);
        REQUIRE(path.prefix() == "//?/");
    }
}
