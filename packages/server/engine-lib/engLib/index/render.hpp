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

#pragma once

namespace engine::index {

// Render document text to buffer
template <typename Buffer>
void renderWords(const WordDbRead& db, DocId docId, Buffer& buff,
                 Opt<size_t> maxLength = {},
                 Opt<Ref<bool>> truncated = {}) noexcept {
    if (truncated) truncated->get() = false;

    size_t length = {};
    for (auto wordId : db.lookupDocWordIdList(docId)) {
        // Stop at the first reserved word (i.e. metadata boundary)
        if (db::isReservedWordId(wordId)) break;

        auto word = db.lookupWord(wordId);
        if (maxLength && length + word.length() > *maxLength) {
            if (truncated) truncated->get() = true;
            return;
        }

        buff << word;
        length += word.length();
    }
}

// Render document text to string
inline Text renderWords(const WordDbRead& db, DocId docId,
                        Opt<size_t> maxLength = {},
                        Opt<Ref<bool>> truncated = {}) noexcept {
    Text text;
    auto buffer = string::PackAdapter{text, 0};
    renderWords(db, docId, buffer, maxLength, truncated);
    return text;
}

// Render document text to file path
inline Error renderWordsToFile(const WordDbRead& db, DocId docId,
                               const file::Path& path,
                               Opt<size_t> maxLength = {},
                               Opt<Ref<bool>> truncated = {}) noexcept {
    if (truncated) truncated->get() = false;

    file::FileStream stream;
    if (auto ccode = stream.open(path, file::Mode::WRITE)) return ccode;

    // Add the UTF-8 BOM as a courtesy
    stream.write(string::unicode::Utf8Bom);

    // Ideally, we'd just call renderWords above with the stream as the buffer,
    // but streams don't support << and there is currently no PackAdapter
    // implementation for streams
    size_t length = {};
    for (auto wordId : db.lookupDocWordIdList(docId)) {
        // Stop at the first reserved word (i.e. metadata boundary)
        if (db::isReservedWordId(wordId)) break;

        auto word = db.lookupWord(wordId);
        if (maxLength && length + word.length() > *maxLength) {
            if (truncated) truncated->get() = true;
            return {};
        }

        stream.write(word);
        length += word.length();
    }

    return {};
}

}  // namespace engine::index
