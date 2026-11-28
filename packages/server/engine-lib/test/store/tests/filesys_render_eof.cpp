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
/// A file truncated after its stream begins made every read return zero
/// bytes, so the renderer sent empty data tags forever. It must stop, save
/// Ec::Read on the entry, and still end the stream.
TEST_CASE("store::filesys reports unexpected EOF without empty data tags") {
    using namespace filesys_render_test;
    const auto size = GENERATE(size_t(6), size_t(1024 * 1024));
    const auto retained = GENERATE(size_t(0), size_t(3));
    File file(size);
    auto entry = file.entry();
    bool truncated = false;
    auto result = render(entry, [&](Sink &sink) {
        sink.onTag = [&](const TAG *tag) -> Error {
            if (tag->tagId == TAG_OBJECT_STREAM_BEGIN::ID) {
                if (::ftruncate(file.fd, retained) != 0)
                    return APERR(errno, "Truncate test file");
                truncated = true;
            }
            return {};
        };
    }, [&](const Sink &sink) {
        REQUIRE(truncated);
        REQUIRE(sink.bytes == retained);
        REQUIRE(sink.emptyDataTags == 0);
        REQUIRE(sink.count(TAG_OBJECT_STREAM_END::ID) == 1);
        REQUIRE(sink.count(TAG_OBJECT_END::ID) == 0);
    });
    // Source failures are stored on the object so other objects can continue.
    REQUIRE_NO_ERROR(result);
    REQUIRE(entry.objectFailed());
    REQUIRE(entry.completionCode().code() == Ec::Read);
}
/// Control case: an unchanged file streams all of its bytes and completes.
TEST_CASE("store::filesys completes a file that does not shrink") {
    using namespace filesys_render_test;
    const auto size = GENERATE(size_t(6), size_t(1024 * 1024));
    File file(size);
    auto entry = file.entry();
    auto result = render(entry, [](Sink &) {}, [&](const Sink &sink) {
        REQUIRE(sink.bytes == size);
        REQUIRE(sink.emptyDataTags == 0);
        REQUIRE(sink.count(TAG_OBJECT_STREAM_END::ID) == 1);
        REQUIRE(sink.count(TAG_OBJECT_END::ID) == 1);
    });
    REQUIRE_NO_ERROR(result);
    REQUIRE_FALSE(entry.objectFailed());
}
#endif
