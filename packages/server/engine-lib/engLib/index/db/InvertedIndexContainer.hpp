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

#pragma once

namespace engine::index::db {

// Define inverted index entry
#pragma pack( \
    push,     \
    1)  // pack contents of struct to 1-byte alignment (just to be explicit)
struct IIEntry {
    DocId docId{0};
    WordId wordId{0};

    IIEntry(DocId dId = 0, WordId wId = 0) : docId(dId), wordId(wId) {}

    bool operator==(const IIEntry &b) const {
        return this->docId == b.docId && this->wordId == b.wordId;
    };
};
#pragma pack(pop)

// our big segment that contains {docId, wordId} for each word (possible with
// duplicates)
using IIEntriesVector = std::vector<IIEntry>;

struct {
    // returns ?true if the first argument is less than (i.e. is ordered before)
    // the second
    bool operator()(const IIEntry &a, const IIEntry &b) const {
        // first sort by word id then by doc id

        if (a.wordId == b.wordId) {  // wordIds equal -> check docId ordering
            return a.docId < b.docId;
        }

        // ordered by wordId -> true, false otherwise
        return (a.wordId < b.wordId);
    }
} IIEntryComparator;

// Entry in segments control table
struct ControlTableEntry {
    size_t segmentOffset{
        0};  // The offset in bytes where this segment starts in file
    size_t entriesCount{0};      // The number of entries in current segment
    size_t segmentSizeBytes{0};  // Size in bytes of current segment
    size_t entryOffset{
        0};  // During merge step we read chunks of each segment from file and
             // then iterate through this chunk in memory. So this is the offset
             // from the beginning of current chunk that we`ve iterated so far
    size_t chunkOffset{0};  // And this is the offset of current chunk from the
                            // beginning of its segment in file
};

// Control table used on merge step
using SegmentsControlTable = std::vector<ControlTableEntry>;

}  // namespace engine::index::db
