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

namespace engine::tag {

// WordIndex is the tag representing the top level control file containing
// the collations and associations of words to their doc ids, docs to their word
// ids, etc. It is written at the end of the word index stream.
struct WordIndex {
    // An offset, count, and size structure, everything needed to re-hydrate a
    // flat allocator for each index this entry represents
    struct Entry {
        uint64_t offset{0};  // offset in memory map where this thing starts at
        uint64_t count{0};   // number of items in the map where the elements
                             // were allocated at
        uint64_t size{0};    // total byte size of the reserved area

        template <typename Buffer>
        auto __toString(Buffer& buff) const noexcept {
            buff << "Offset: " << Size(offset).toString(true)
                 << " Count: " << Count(count)
                 << " Size: " << Size(size).toString(true);
        }
    };
    static_assert(sizeof(Entry) == 24);

    // The offset table describes the major mapped regions of the word index
    // if KEEP_CASE_INDEX is not defined and we don`t store the index itself
    // in the word index file we still keep the offsets table the old way
    // to keep backward compatibility. If we`re opening the old word index file
    // it will have OffsetTable with wordCaseIndex in it. So in order to read
    // the headers table correctly we need to know its size.
    // This is why we are not removing wordCaseIndex entry from headers table.
    struct OffsetTable {
        Entry docWordIdLists;
        Entry docWordIdListIndex;
        Entry wordDocIdSets;
        Entry wordDocIdSetIndex;
        Entry wordStrings;
        Entry docHashIndex;
        Entry docIdIndex;
        Entry wordIdIndex;
        Entry wordCaseIndex;
        Entry wordNoCaseIndex;

        template <typename Buffer>
        auto __toString(Buffer& buff) const noexcept {
            buff << "\n";
            buff << "DocWordIdLists" << docWordIdLists << "\n";
            buff << "DocWordIdListIndex" << docWordIdListIndex << "\n";
            buff << "WordDocIdSets" << wordDocIdSets << "\n";
            buff << "WordDocIdSetIndex" << wordDocIdSetIndex << "\n";
            buff << "WordStrings" << wordStrings << "\n";
            buff << "DocHashIndex " << docHashIndex << "\n";
            buff << "DocIdIndex " << docIdIndex << "\n";
            buff << "WordIdIndex " << wordIdIndex << "\n";
            buff << "WordCaseIndex " << wordCaseIndex << "\n";
            buff << "WordNoCaseIndex " << wordNoCaseIndex << "\n";
        }
    };

    auto __validate() const noexcept(false) { hdr.__validate(); }

    operator InputData() const noexcept {
        return {_reCast<const uint8_t*>(this), sizeof(WordIndex)};
    }

    operator OutputData() noexcept {
        return {_reCast<uint8_t*>(this), sizeof(WordIndex)};
    }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << offsets;
    }

    Hdr<Class::Words, Type::Index> hdr;
    OffsetTable offsets;
};

static_assert(std::is_standard_layout_v<WordIndex>);

}  // namespace engine::tag
