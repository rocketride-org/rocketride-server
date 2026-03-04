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

TEST_CASE("file::sizeOnDisk") {
    // Verify getDiskClusterSize works
    file::Path testRoot = testPath();
    const auto diskClusterSize = *file::getDiskClusterSize(testRoot);

    // getSizeOnDisk should fail for directories
    auto stats = *file::stat(testRoot);
    REQUIRE_THROWS(*file::getSizeOnDisk(testRoot, stats.size,
                                        stats.plat.dwFileAttributes));

    // Create an empty file
    const auto path = testRoot / "sizeOnDisk.dat";
    file::stream::File file;
    *file.open(path.plat(), file::Mode::WRITE);

    // getSizeOnDisk should return 0 for empty files
    stats = *file::stat(path);
    auto sizeOnDisk =
        *file::getSizeOnDisk(path, stats.size, stats.plat.dwFileAttributes);
    REQUIRE(sizeOnDisk == 0);

    // Write a few bytes
    file.write("hello"_tv);
    file.close();

    // Verify the file is non-empty and that size on disk was calculated via
    // _transform
    stats = *file::stat(path);
    REQUIRE(stats.size);
    REQUIRE(stats.sizeOnDisk);

    // Verify that the size on disk is the size of a single disk cluster
    sizeOnDisk =
        *file::getSizeOnDisk(path, stats.size, stats.plat.dwFileAttributes);
    REQUIRE(sizeOnDisk == diskClusterSize);

    // Verify that the calculated size on disk matches what was returned from
    // file::stat
    REQUIRE(sizeOnDisk == stats.sizeOnDisk);
}