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

TEST_CASE("file::lock") {
    // Initialize a test file
    auto path = testPath() / "file.txt";
    *file::put(path, "xyz"_tv);

    // When opened in read mode, all attempts to open in write or update modes
    // should fail
    _using(file::FileStream readLocked(path, file::Mode::READ)) {
        REQUIRE_NOTHROW(file::FileStream(path, file::Mode::STAT));
        REQUIRE_NOTHROW(file::FileStream(path, file::Mode::READ));
        REQUIRE_THROWS(file::FileStream(path, file::Mode::WRITE));
        REQUIRE_THROWS(file::FileStream(path, file::Mode::UPDATE));
    }

    // When opened in write mode, the file is exclusively locked, and all other
    // attempts to open it should fail Opening in STAT mode should ignore locks,
    // though
    _using(file::FileStream writeLocked(path, file::Mode::WRITE)) {
        REQUIRE_NOTHROW(file::FileStream(path, file::Mode::STAT));
        REQUIRE_THROWS(file::FileStream(path, file::Mode::READ));
        REQUIRE_THROWS(file::FileStream(path, file::Mode::WRITE));
        REQUIRE_THROWS(file::FileStream(path, file::Mode::UPDATE));
    }

    // Same for update mode
    _using(file::FileStream updateLocked(path, file::Mode::UPDATE)) {
        REQUIRE_NOTHROW(file::FileStream(path, file::Mode::STAT));
        REQUIRE_THROWS(file::FileStream(path, file::Mode::READ));
        REQUIRE_THROWS(file::FileStream(path, file::Mode::WRITE));
        REQUIRE_THROWS(file::FileStream(path, file::Mode::UPDATE));
    }
}