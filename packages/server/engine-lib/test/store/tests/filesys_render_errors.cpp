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
TEST_CASE("store::filesys preserves a return-only data error during stream cleanup") {
    using namespace filesys_render_test;
    const auto size = GENERATE(size_t(6), size_t(1024 * 1024));
    const bool cleanupFails = GENERATE(false, true);
    File file(size);
    auto entry = file.entry();
    auto result = render(entry, [&](Sink &sink) {
        sink.onTag = [&](const TAG *tag) -> Error {
            if (tag->tagId == TAG_OBJECT_STREAM_DATA::ID)
                return APERR(Ec::Write, "Test destination write failure");
            if (tag->tagId == TAG_OBJECT_STREAM_END::ID && cleanupFails)
                return APERR(Ec::Failed, "Test stream cleanup failure");
            return {};
        };
    }, [&](const Sink &sink) {
        REQUIRE(sink.count(TAG_OBJECT_STREAM_DATA::ID) == 1);
        REQUIRE(sink.count(TAG_OBJECT_STREAM_END::ID) == 1);
        REQUIRE(sink.count(TAG_OBJECT_END::ID) == 0);
    });
    REQUIRE(result.code() == Ec::Write);
    REQUIRE_FALSE(entry.objectFailed());
}

TEST_CASE("store::filesys returns a stream-end error when data succeeded") {
    using namespace filesys_render_test;
    File file(6);
    auto entry = file.entry();
    auto result = render(entry, [](Sink &sink) {
        sink.onTag = [](const TAG *tag) -> Error {
            if (tag->tagId == TAG_OBJECT_STREAM_END::ID)
                return APERR(Ec::Failed, "Test stream cleanup failure");
            return {};
        };
    }, [](const Sink &sink) {
        REQUIRE(sink.bytes == 6);
        REQUIRE(sink.count(TAG_OBJECT_STREAM_END::ID) == 1);
    });
    REQUIRE(result.code() == Ec::Failed);
}
#endif
