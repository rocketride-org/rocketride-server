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
/// A file with data before its first hole was streamed from byte 0 but tagged
/// with the first hole's offset, so a filesys store wrote the copy shifted by
/// that offset. The stream must start at offset 0 and carry the file as is.
TEST_CASE("store::filesys starts a partly sparse stream at offset zero") {
    using namespace filesys_render_test;
    const size_t head = 4096, size = 1024 * 1024;
    File file(head);
    REQUIRE(::ftruncate(file.fd, size) == 0);
    if (::lseek(file.fd, 0, SEEK_HOLE) != static_cast<off_t>(head)) {
        WARN("filesystem does not report the hole; nothing to check");
        return;
    }
    auto entry = file.entry();
    Opt<TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE> streamType;
    Opt<Qword> streamOffset;
    std::vector<Byte> data;
    auto result = render(entry, [&](Sink &sink) {
        sink.onTag = [&](const TAG *tag) -> Error {
            if (tag->tagId == TAG_OBJECT_STREAM_BEGIN::ID) {
                const auto *begin =
                    static_cast<const TAG_OBJECT_STREAM_BEGIN *>(tag);
                streamType = begin->data.streamType;
                streamOffset = begin->data.streamOffset;
            } else if (tag->tagId == TAG_OBJECT_STREAM_DATA::ID) {
                const auto *chunk =
                    static_cast<const TAG_OBJECT_STREAM_DATA *>(tag);
                data.insert(data.end(), chunk->data.data,
                            chunk->data.data + tag->size);
            }
            return {};
        };
    }, [](const Sink &sink) {
        REQUIRE(sink.count(TAG_OBJECT_STREAM_BEGIN::ID) == 1);
        REQUIRE(sink.count(TAG_OBJECT_END::ID) == 1);
    });
    REQUIRE_NO_ERROR(result);
    REQUIRE_FALSE(entry.objectFailed());
    REQUIRE(streamType ==
            TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_SPARSE_BLOCK);
    REQUIRE(streamOffset == Qword(0));
    REQUIRE(data.size() == size);
    REQUIRE(std::all_of(data.begin(), data.begin() + head,
                        [](Byte value) { return value == 'x'; }));
    REQUIRE(std::all_of(data.begin() + head, data.end(),
                        [](Byte value) { return value == 0; }));
}
#endif
