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

using namespace async;

TEST_CASE("async::Buffers") {
    SECTION("Standard") {
        Buffers<char> buffers;

        *buffers.init({});

        auto input = "Hi!"_tv;

        // Writer side fills in the buffer with our input string
        auto buff = *buffers.writerPop();
        buff.cursor.copy<char>(input);
        buff.cursor += input.size();
        REQUIRE(buff.writerSizeUsed() == input.size());
        buffers.writerPush(_mv(buff));

        // Flush as we did not fully consume a buffer and it will have it staged
        buffers.flush(false);

        // Reader side, test the partial caching by reading 1 character
        // at a time between pop/pushes, it should cache it for us
        Text output;
        while (output.size() < input.size()) {
            buff = *buffers.readerPop();
            REQUIRE(buff.readerSizeAvail() == input.size() - output.size());
            output += *buff.cursor++;
            buffers.readerPush(_mv(buff));
        }
        REQUIRE(output == input);
    }

    SECTION("Custom Ctx") {
        Buffers<char, std::allocator<char>, int> buffers;

        *buffers.init({});

        auto input = "Hi!"_tv;

        // Reader side, read all buffers and verify the context value was
        // retained
        auto reader = async::work::submit(_location, "Reader", [&] {
            auto next = 0;
            while (auto buff = buffers.readerPop()) {
                Text output;
                ASSERTD_MSG(buff->ctx == next, buff->ctx, "!=", next);
                output.resize(buff->readerSizeAvail());
                _copyTo(output, buff->cursor);
                buffers.readerPush(_mv(buff), true);
                next++;
                ASSERTD_MSG(output == input, output, "!=", input);
            }
        });

        // Writer side fills in the buffer with our input string
        for (auto i = 0; i < 5; i++) {
            auto buff = *buffers.writerPop();
            buff.ctx = i;
            buff.cursor.copy<char>(input);
            buff.cursor += input.size();
            REQUIRE(buff.writerSizeUsed() == input.size());
            buffers.writerPush(_mv(buff), true);
        }

        // Mark the writer operation completed and wait for the reader to finish
        buffers.flush();
    }
}
