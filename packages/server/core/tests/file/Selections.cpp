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

TEST_CASE("file::Selections") {
#if ROCKETRIDE_PLAT_WIN
    SECTION("?") {
        file::Selections matcher;
        matcher.addInclude("C:/Users?", 0);
        REQUIRE(!matcher.isIncluded("C:/Users"));

        REQUIRE(matcher.isIncluded("C:/Usersa"));

        REQUIRE(!matcher.isIncluded("C:/Usersabcdefg"));

        REQUIRE(*matcher.resolve(false) == std::vector{"C:"_pth});
    }

    SECTION("/*") {
        file::Selections matcher;
        matcher.addInclude("C:/Users/*", 0);

        REQUIRE(!matcher.isIncluded("C:/User"));

        REQUIRE(matcher.isIncluded("C:/Users/file.txt"));

        REQUIRE(*matcher.resolve(false) == std::vector{"C:/Users"_pth});
    }

    SECTION("*") {
        file::Selections matcher;
        matcher.addInclude("C:/Users*", 0);

        REQUIRE(!matcher.isIncluded("C:/User"));

        REQUIRE(matcher.isIncluded("C:/Usersa"));

        REQUIRE(matcher.isIncluded("C:/Usersabcdefg"));

        REQUIRE(*matcher.resolve(false) == std::vector{"C:"_pth});
    }

    SECTION("[abc]") {
        file::Selections matcher;
        matcher.addInclude("C:/Users[abc]", 0);

        REQUIRE(!matcher.isIncluded("C:/Usersd"));

        REQUIRE(matcher.isIncluded("C:/Usersa"));

        REQUIRE(matcher.isIncluded("C:/Usersb"));

        REQUIRE(matcher.isIncluded("C:/Usersc"));

        REQUIRE(!matcher.isIncluded("C:/Usersabc"));
    }

    SECTION("[a-c]") {
        file::Selections matcher;
        matcher.addInclude("C:/Users[a-c]", 0);

        REQUIRE(!matcher.isIncluded("C:/Userd"));

        REQUIRE(matcher.isIncluded("C:/Usersa"));

        REQUIRE(matcher.isIncluded("C:/Usersb"));

        REQUIRE(matcher.isIncluded("C:/Usersc"));

        REQUIRE(!matcher.isIncluded("C:/Usersabc"));
    }

    SECTION("[^a-c]") {
        file::Selections matcher;
        matcher.addInclude("C:/Users[^a-c]", 0);

        REQUIRE(matcher.isIncluded("C:/Usersd"));

        REQUIRE(!matcher.isIncluded("C:/Userd"));

        REQUIRE(!matcher.isIncluded("C:/Usersa"));

        REQUIRE(!matcher.isIncluded("C:/Usersb"));

        REQUIRE(!matcher.isIncluded("C:/Usersc"));

        REQUIRE(!matcher.isIncluded("C:/Usersabc"));
    }

    SECTION("Search by file name") {
        file::Selections matcher;
        matcher.addInclude("*file1.txt", 0);
        REQUIRE(matcher.isIncluded("C:/file1.txt"));
    }

    SECTION("Scan path detection") {
        SECTION("Two selections trailing glob") {
            file::Selections matcher;
            matcher.addInclude("C:/Users[^a-c]", 0);
            auto scanList = matcher.resolve(false);
            LOG(Test, "Result", scanList);
            REQUIRE(*matcher.resolve(false) == std::vector{{"C:"_pth}});
        }

        SECTION("Redundant children") {
            file::Selections matcher;
            matcher.addInclude("C:/Users/*", 0);
            matcher.addInclude("C:/Users/Downloads", 0);
            auto paths = *matcher.resolve(false);
            REQUIRE(paths == std::vector{{
                                 "C:/Users"_pth,
                             }});
        }

        SECTION("Case normalization") {
            auto path1 = testPath();
            REQUIRE(!file::mkdir(path1 / "A DIR"));
            auto path2 = testPath();
            REQUIRE(!file::mkdir(path2 / "Another DIR"));
            file::Selections matcher;
            matcher.addInclude((TextView)(path1 / "a dir/*"), 0);
            matcher.addInclude((TextView)(path2 / "another dir/*"), 0);
            auto scanPaths = matcher.resolve(true);
            REQUIRE(scanPaths);
            auto expectedDir1 = path1 / "A DIR";
            auto expectedDir2 = path2 / "Another DIR";
            REQUIRE(_findIf(*scanPaths, expectedDir1) != scanPaths->end());
            REQUIRE(_findIf(*scanPaths, expectedDir2) != scanPaths->end());
        }

        SECTION("No failure on root") {
            file::Selections matcher;
            matcher.addInclude("c:/windows/*", 0);
            auto scanPaths = matcher.resolve();
            REQUIRE(scanPaths);
            REQUIRE(scanPaths->size() == 1);
            REQUIRE(scanPaths->at(0) == "C:/Windows"_pth);
        }
    }
#else
    SECTION("Trailing * should add base parent") {
        file::Selections matcher;
        matcher.addInclude("/tmp/any*", 0);
        auto scanPaths = matcher.resolve();
        REQUIRE(scanPaths);
        REQUIRE(scanPaths->size() == 1);
        REQUIRE(scanPaths->at(0) == "/tmp"_pth);
    }
#endif

    SECTION("Selection errors") {
        file::Selections matcher;

        // If no selections, we used to error out here, but, for different types
        // of source endpoints, they may not actually have the concept of
        // include paths
        // // No selections should yield InvalidSelection
        // REQUIRE(matcher.resolve().ccode() == APERR(Ec::InvalidSelection));

        // Note - these test are no longer valid since we don't check if paths
        // exist prior to adding them. This is due to the fact that a) it is
        // very file system centric, and b) the globber can work with funky
        // paths that really don't exist, but do match real paths

        // A single missing selection should also yield InvalidSelection
        // file::Path missingPath = "/shamalamadingdong";
        // REQUIRE_FALSE(file::exists(missingPath));
        // matcher.addInclude(missingPath, 0);
        // REQUIRE(matcher.resolve().ccode() == APERR(Ec::InvalidSelection));

        // This directory will be a child of the application directory
        // missingPath = application::execDir() / "shamalamadingdong";
        // REQUIRE_FALSE(file::exists(missingPath));
        // matcher.addInclude(missingPath, 0);
        // // The matcher will now include two selections-- one missing (from
        // previous test) and one with a valid parent std::vector<Error>
        // problems;
        // // The parent will not be included
        // REQUIRE(matcher.resolve(true, problems).ccode() ==
        // APERR(Ec::InvalidSelection));
        // // The problems vector should note both the missing selection and the
        // selected-in-lieu parent REQUIRE(problems.size() == 2);
    }
    SECTION("Parent and Child with *") {
        file::Selections matcher;
        json::Value includePaths;
        includePaths["include"][0]["path"] = "C:\\Parent\\Child\\*";
        includePaths["include"][1]["path"] = "C:\\Parent\\Child\\Child2\\*";
        includePaths["include"][2]["path"] =
            "C:\\Parent\\Child\\Child2\\Child3\\*";
        includePaths["include"][3]["path"] = "C:\\Parent\\*";
        includePaths["include"][4]["path"] = "D:\\Parent\\*";
        matcher.addIncludes(includePaths);
        std::vector<file::Path> paths = matcher.resolve();
        REQUIRE(paths.size() == 2);
        REQUIRE(paths[0] == "C:\\Parent");
        REQUIRE(paths[1] == "D:\\Parent");
    }
    SECTION("Parent and Child") {
        file::Selections matcher;
        json::Value includePaths;
        includePaths["include"][0]["path"] = "C:\\Parent\\Child\\";
        includePaths["include"][1]["path"] = "C:\\Parent\\Child\\Child2\\";
        includePaths["include"][2]["path"] =
            "C:\\Parent\\Child\\Child2\\Child3\\";
        includePaths["include"][3]["path"] = "C:\\Parent\\";
        includePaths["include"][4]["path"] = "D:\\Parent\\";
        matcher.addIncludes(includePaths);
        std::vector<file::Path> paths = matcher.resolve();
        REQUIRE(paths.size() == 2);
        REQUIRE(paths[0] == "C:");
        REQUIRE(paths[1] == "D:");
    }
}
