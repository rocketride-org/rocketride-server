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

TEST_CASE("file::scan::File") {
    SECTION("Utf8") {
        file::FileScanner scanner(application::execPath(true));
        REQUIRE(!scanner.open());
        while (auto entry = scanner.next()) {
            LOG(Test, "Enumed: {}", entry->first);
        }
    }

    SECTION("Utf8 Stack allocator") {
        StackStrAllocator<Utf8Chr> allocator;
        file::scan::FileScanner<Utf8Chr, decltype(allocator)> scanner(
            application::execPath(true), allocator);
        REQUIRE(!scanner.open());
        while (auto entry = scanner.next())
            LOG(Test, "Enumed: {}", entry->first);
    }

    SECTION("pathOf") {
        const auto applicationDir = application::execPath(true);
        const auto applicationPath = application::execPath(false);

        // Verify enumerated items for absolute directory path (must yield just
        // the directory itself)
        _using(file::FileScanner dirScanner(applicationDir)) {
            REQUIRE(!dirScanner.open());
            while (auto entry = dirScanner.next()) {
                const auto entryPath = dirScanner.pathOf(entry->first);
                REQUIRE(file::exists(entryPath));
                REQUIRE(entryPath == applicationDir);
            }
        }

        // Verify enumerated items for absolute file path (must yield just the
        // file itself)
        _using(file::FileScanner fileScanner(applicationPath)) {
            REQUIRE(!fileScanner.open());
            while (auto entry = fileScanner.next()) {
                const auto entryPath = fileScanner.pathOf(entry->first);
                REQUIRE(file::exists(entryPath));
                REQUIRE(entryPath == applicationPath);
            }
        }

        // Verify enumerated items for absolute directory path + wildcard
        _using(file::FileScanner dirScanner(applicationDir / "*")) {
            REQUIRE(!dirScanner.open());
            while (auto entry = dirScanner.next()) {
                const auto entryPath = dirScanner.pathOf(entry->first);
                REQUIRE(file::exists(entryPath));
                REQUIRE(entryPath == applicationDir / entry->first);
            }
        }
    }

#if ROCKETRIDE_PLAT_WIN
    SECTION("Utf16") {
        file::scan::FileScanner<Utf16Chr, std::allocator<Utf16Chr>> scanner(
            L"c:/windows/*"_tv);
        REQUIRE(!scanner.open());
        while (auto entry = scanner.next())
            LOG(Test, "Enumed: {}", entry->first);
    }

    SECTION("Utf16 Stack allocator") {
        StackStrAllocator<Utf16Chr> allocator;
        file::scan::FileScanner<Utf16Chr, decltype(allocator)> scanner(
            L"c:/windows/*"_tv, allocator);
        REQUIRE(!scanner.open());
        while (auto entry = scanner.next())
            LOG(Test, "Enumed: {}", entry->first);
    }
#endif
}
