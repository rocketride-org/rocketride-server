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

// The test case is optional due to unstable failures
// when running on GitHub agents
TEST_CASE("file::FileStream", "[.]") {
    SECTION("Basic i/o") {
        auto root = testPath();
        file::FileStream stream;
        REQUIRE(!stream.open(root / "file.txt", file::Mode::WRITE));
        REQUIRE(stream.offset() == 0);
        REQUIRE(!stream.write("Hi there!"));
        REQUIRE(stream.offset() == 10);
        stream.close();
        REQUIRE(!stream.open(root / "file.txt", file::Mode::READ));
        REQUIRE(stream.offset() == 0);
        REQUIRE(*stream.read(9) == "Hi there!"_tv);
        REQUIRE(stream.offset() == 9);
    }

    SECTION("Mapped i/o") {
        auto root = testPath();
        auto filePath = root / "mapped_file.dat";
        file::FileStream stream(filePath, file::Mode::WRITE);

        // Initialize the file to one big 10MB memory map
        *stream.mapInit(10_mb);

        std::vector<Text> history;
        auto copyChunk = [&](auto data, auto index) {
            auto &chunk = history.emplace_back(_ts("View #", index));
            LOG(Test, "Copying chunk index", index);
            _copyTo(data, chunk, chunk.size());
        };

        auto validateChunk = [&](auto data, auto index) {
            auto &chunk = history[index];
            REQUIRE(_equalTo(data, chunk));
        };

        // Now create 10 views of 1MB each
        // We should now be able to manipulate the contents of each and have
        // them apply to the file automatically
        for (auto i = 0_b; i < 10_mb; i += 1_mb) {
            LOG(Test, "Mapping offset {} size {}", i, 1_mb);
            copyChunk(*stream.mapOutputRange(i, 1_mb), i / 1_mb);
        }

        // Now close the file and re-open it, every 1 MB we should be able to
        // find our text
        stream.close();
        REQUIRE(*file::length(filePath) == 10_mb);

        LOG(Test, "Re-opening file", filePath);

        *stream.open(filePath, file::Mode::READ);

        // Map the entire file this time
        auto data = *stream.mmap();
        REQUIRE(data.size() == 10_mb);

        // Every 1MB look for our string
        for (auto i = 0_b; i < 10_mb; i += 1_mb)
            validateChunk(data.sliceAt(i), i / 1_mb);
    }

    SECTION("Adapter traits") {
        file::FileStream stream;
        auto in = memory::adapter::makeInput(stream);
        static_assert(memory::adapter::concepts::IsInputV<decltype(in)>);

        auto out = memory::adapter::makeOutput(stream);
        static_assert(memory::adapter::concepts::IsOutputV<decltype(out)>);
    }
}
