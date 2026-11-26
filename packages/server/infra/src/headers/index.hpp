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

#define USE_WORD_ID_LIST_PAGINATED
// #define TEST_WORD_ID_LIST

namespace engine::index::db {
//-------------------------------------------------------------------------
/// @details
/// 	The word db abstracts the word write and word read (both local and
///		remote) whereby during creation the word db is kept in memory, but
///		during reading the word db is memory mapped to a file
//-------------------------------------------------------------------------
template <file::Mode ModeT>
class WordDb;
}  // namespace engine::index::db

namespace engine {
//-------------------------------------------------------------------------
/// @details
///		Define our maximum word size
//-------------------------------------------------------------------------
const auto MaxWordSize = 256;
}  // namespace engine

namespace engine::index {
//-------------------------------------------------------------------------
/// @details
///		Define our reader/writer
//-------------------------------------------------------------------------
// Define our reader and write db
using WordDbRead = index::db::WordDb<file::Mode::READ>;
using WordDbWrite = index::db::WordDb<file::Mode::WRITE>;

//-------------------------------------------------------------------------
/// @details
///		Fundamental types used by indexing
//-------------------------------------------------------------------------
using WordId = uint32_t;
using WordIdList = std::vector<WordId>;
using PaginatedWordIdList = ap::memory::PaginatedVector<WordId>;
#if defined(USE_WORD_ID_LIST_PAGINATED)
using WordIdListReturnType = PaginatedWordIdList;
#else
using WordIdListReturnType = WordIdList;
#endif
using WordIdListView = memory::DataView<const WordId>;
using WordIdSet = std::set<WordId>;
using WordIdSetView = memory::DataView<const WordId>;
using WordVariationList = std::vector<WordIdList>;
using WordDbReadPtr = std::unique_ptr<WordDbRead>;

using DocHash = crypto::Sha512Hash;
using DocId = uint32_t;
using DocIdList = std::vector<DocId>;
using DocIdListView = memory::DataView<const DocId>;
using DocIdSet = std::set<DocId>;
using DocIdSetView = memory::DataView<const DocId>;
}  // namespace engine::index
