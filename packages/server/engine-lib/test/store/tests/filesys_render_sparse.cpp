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

#include "filesys_render_fixture.hpp"

#if ROCKETRIDE_PLAT_UNX
/// Sparse files have zero allocated blocks, like pseudo files, and were
/// silently dropped. They must render metadata and their full logical
/// (all-zero) contents.
TEST_CASE("store::filesys renders logical sparse file contents") {
    using namespace filesys_render_test;
    const auto size = GENERATE(size_t(0), size_t(6), size_t(1024 * 1024));
    File file(size, true);
    struct stat info {};
    REQUIRE(::fstat(file.fd, &info) == 0);
    REQUIRE(info.st_size == static_cast<off_t>(size));
    REQUIRE(info.st_blocks == 0);
    auto entry = file.entry();
    auto result = render(entry, [](Sink &) {}, [&](const Sink &sink) {
        REQUIRE(sink.count(TAG_OBJECT_METADATA::ID) == 1);
        REQUIRE(sink.count(TAG_OBJECT_STREAM_BEGIN::ID) == 1);
        REQUIRE(sink.count(TAG_OBJECT_STREAM_END::ID) == 1);
        REQUIRE(sink.count(TAG_OBJECT_END::ID) == 1);
        REQUIRE(sink.bytes == size);
        REQUIRE(sink.allZero);
        REQUIRE(sink.emptyDataTags == 0);
    });
    REQUIRE_NO_ERROR(result);
    REQUIRE_FALSE(entry.objectFailed());
}
#endif

#if ROCKETRIDE_PLAT_LIN
/// Pseudo files must still be skipped. Returns early with a warning when
/// the sysfs file is missing or does not report a size with no blocks.
TEST_CASE("store::filesys keeps skipping sysfs pseudo-file payloads") {
    using namespace filesys_render_test;
    const char *path = "/sys/kernel/uevent_seqnum";
    struct stat info {};
    if (::stat(path, &info) != 0 || info.st_size == 0 || info.st_blocks != 0) {
        WARN("sysfs fixture is unavailable; sparse-file tests still run");
        return;
    }
    Entry entry(Url{"filesys://test/sys/kernel/uevent_seqnum"});
    auto result = render(entry, [](Sink &) {}, [](const Sink &sink) {
        REQUIRE(sink.count(TAG_OBJECT_METADATA::ID) == 0);
        REQUIRE(sink.count(TAG_OBJECT_STREAM_BEGIN::ID) == 0);
        REQUIRE(sink.count(TAG_OBJECT_END::ID) == 1);
    });
    REQUIRE_NO_ERROR(result);
    REQUIRE_FALSE(entry.objectFailed());
}
#endif
