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

TEST_CASE("file::scan::VolumeScanner") {
    SECTION("Utf8") {
        file::VolumeScanner scanner;
        *scanner.open();
        while (auto entry = scanner.next()) LOG(Test, "Enumed: {}", entry);
    }

    SECTION("Utf16") {
        file::scan::Scanner<Utf16Chr, std::allocator<Utf16Chr>, Lvl::Test,
                            file::scan::Volume>
            scanner;
        *scanner.open();
        while (auto entry = scanner.next()) LOG(Test, "Enumed: {}", entry);
    }

    SECTION("Utf8 Stack allocator") {
        StackStrAllocator<Utf8Chr> allocator;
        file::scan::Scanner<Utf8Chr, decltype(allocator), Lvl::Test,
                            file::scan::Volume>
            scanner(allocator);
        *scanner.open();
        while (auto entry = scanner.next()) LOG(Test, "Enumed: {}", entry);
    }

    SECTION("Utf16 Stack allocator") {
        StackStrAllocator<Utf16Chr> allocator;
        file::scan::Scanner<Utf16Chr, decltype(allocator), Lvl::Test,
                            file::scan::Volume>
            scanner(allocator);
        *scanner.open();
        while (auto entry = scanner.next()) LOG(Test, "Enumed: {}", entry);
    }
}
