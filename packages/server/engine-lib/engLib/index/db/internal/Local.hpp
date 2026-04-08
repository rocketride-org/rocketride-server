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

namespace engine::index::db::internal {
// The read mode word db is a mapped read only version of the word db, using
// memory mapped i/o for instant loading of the pre-sorted data structures on
// disk
class Local {
public:
    _const auto LogLevel = Lvl::WordDb;

    Local() = default;

    Local(const file::Path &path) noexcept(false) { *open(path); }

    ~Local() noexcept { close(); }

    TextView lookupWord(WordId id) const noexcept {
        // If it's a reserved word, render it
        if (auto word = renderReservedWordId(id)) return word;

        if (auto iter = m_wordIdIndex->find(id); iter != m_wordIdIndex->end())
            return lookupWord(iter->second);

        // Shouldn't be possible otherwise
        ASSERT_MSG(!id, "Invalid word ID");
        return {};
    }

    TextView lookupWord(const ProxyWord &addr) const noexcept {
        ASSERT_MSG(m_wordStrings->size() >= addr.offset + addr.size,
                   "Invalid proxy word address", addr);
        ASSERT_MSG(addr.size != 0, "Invalid proxy word address length", addr);
        return {&m_wordStrings->operator[](addr.offset), addr.size};
    }

    WordIdList lookupWordIds(iTextView word) const noexcept {
        WordIdList result;
        auto [start, end] = m_wordNoCaseIndex->equal_range(word);
        result.reserve(std::distance(start, end));
        util::transform(
            result, start, end,
            [&](auto addr, auto wordId) noexcept { return wordId; });
        return result;
    }

    WordId lookupWordId(TextView word) const noexcept {
#ifdef KEEP_CASE_INDEX
        if (auto iter = m_wordCaseIndex->find(word);
            iter != m_wordCaseIndex->end())
            return iter->second;
#else
        auto [start, end] = m_wordNoCaseIndex->equal_range(word);

        for (auto q = start; q != end; ++q) {
            if (lookupWord(q->first) == word) {
                return q->second;
            }
        }
#endif
        return {};
    }

    DocIdList lookupDocIds(WordId wordId) const noexcept {
        return lookupIds(false, wordId, *m_wordDocIdSetIndex, *m_wordDocIdSets);
    }

    template <typename ContainerT,
              typename = std::enable_if<traits::IsContainerV<ContainerT>>>
    void lookupDocIds(WordId wordId, ContainerT &out) const noexcept {
        auto docIds = lookupDocIds(wordId);

        if (!docIds.empty()) _addTo(out, docIds);
    }

    DocId lookupDocId(const DocHash &hash) const noexcept {
        if (auto iter = m_docHashIndex->find(hash);
            iter != m_docHashIndex->end())
            return iter->second;
        return {};
    }

    Opt<DocHash> lookupDocHash(DocId docId) const noexcept {
        if (auto iter = m_docIdIndex->find(docId); iter != m_docIdIndex->end())
            return iter->second;
        return NullOpt;
    }

    bool hasDocId(DocId docId) const noexcept {
        return m_docWordIdListIndex->find(docId) != m_docWordIdListIndex->end();
    }

    WordIdListReturnType lookupDocWordIdList(DocId docId) const noexcept {
#if !defined(USE_WORD_ID_LIST_PAGINATED)
        return lookupIds(true, docId, *m_docWordIdListIndex, *m_docWordIdLists);
#else
        return lookupIdsPaginated<WordId>(true, docId, *m_docWordIdListIndex,
                                          *m_docWordIdLists);
#endif
    }

    template <typename T>
    void lookupDocMetadataWordIds(DocId id, T &cnt) const noexcept {
        cnt.clear();

        // Are the metadata words for this document already cached?
        auto lock = m_mutex.lock();
        if (auto iter = m_docMetadataWordIds.find(id);
            iter != m_docMetadataWordIds.end()) {
            _addTo(cnt, iter->second);
            return;
        }

        // Nope-- load the document words and scan backwards for the start of
        // the metadata
        auto docWordIds = lookupDocWordIdList(id);
        auto metadataStart =
            std::find(docWordIds.rbegin(), docWordIds.rend(),
                      EnumIndex(ReservedWordId::MetadataBlockStart));
        auto &cachedMetadataWordIds = m_docMetadataWordIds[id];

        // No metadata start found-- the empty set is already cached, so just
        // bail
        if (metadataStart == docWordIds.rend()) {
            LOGT("No metadata found for document", id);
            return;
        }

        // Copy the metadata word IDs to the cache and the container, including
        // the boundary Adjust by 1 when converting from reverse_iterator to
        // forward iterator
        cachedMetadataWordIds.assign(metadataStart.base() - 1,
                                     docWordIds.end());
        _addTo(cnt, cachedMetadataWordIds);
    }

    ErrorOr<Metadata> getDocMetadata(DocId docId) const noexcept {
        Metadata metadata;
        //@@ if (auto ccode = metadata.load(*this, docId))
        // 	return ccode;
        return metadata;
    }

    auto docCount() const noexcept { return m_docWordIdListIndex->size(); }

    size_t docWordCount(DocId docId) const noexcept {
        auto iter = m_docWordIdListIndex->find(docId);
        if (iter != m_docWordIdListIndex->end()) return iter->second.count;
        return {};
    }

    auto docWordCount() const noexcept {
        size_t count = {};
        for (auto &[docId, wordIdListAddr] : *m_docWordIdListIndex)
            count += wordIdListAddr.count;
        return count;
    }

    auto wordCount() const noexcept { return m_wordNoCaseIndex->size(); }

    auto uniqueWordCount() const noexcept {
#ifdef KEEP_CASE_INDEX
        return m_wordCaseIndex->size();
#else
        return m_wordNoCaseIndex
            ->size();  // m_wordNoCaseIndex has same number of items inside so
                       // it is equivalent
#endif
    }

    auto wordStringsSize() const noexcept { return m_wordStrings->size(); }

    auto &wordIdIndex() const noexcept { return *m_wordIdIndex; }

#ifdef KEEP_CASE_INDEX
    auto &wordCaseIndex() const noexcept { return *m_wordCaseIndex; }
#endif

    auto &wordNoCaseIndex() const noexcept { return *m_wordNoCaseIndex; }

    auto &docIdIndex() const noexcept { return *m_docIdIndex; }

    auto &wordDocIdSetIndex() const noexcept { return *m_wordDocIdSetIndex; }

    size_t docWordIdListCount(const DocHash &docHash) const noexcept {
        if (auto docId = lookupDocId(docHash)) return docWordCount(docId);
        return 0;
    }

    ErrorOr<Size> physicalSize() const noexcept { return m_stream.size(); }

    Stats stats() const noexcept {
        const auto physSize = physicalSize();

        return {.docCount = docCount(),
                .docWords = docWordCount(),
                .uniqueWords = uniqueWordCount(),
                .totalWords = wordCount(),
                .stringsSize = wordStringsSize(),
                .physicalSize = physSize ? *physSize : Size()};
    }

    Error open(const file::Path &path) noexcept {
        if (auto ccode = m_stream.open(path, file::Mode::READ)) return ccode;

        if (auto res = _call([&] { load(path); }); res.check()) {
            m_stream.close();
            return res.ccode();
        }

        return {};
    }

    void close() noexcept {
        m_hdr.reset();
        m_hdrData.reset();

        m_docWordIdLists.reset();
        m_docWordIdListsData.reset();

        m_docWordIdListIndex.reset();
        m_docWordIdListIndexData.reset();

        m_wordDocIdSets.reset();
        m_wordDocIdSetsData.reset();

        m_wordDocIdSetIndex.reset();
        m_wordDocIdSetIndexData.reset();

        m_wordStrings.reset();
        m_wordStringsData.reset();

        m_docHashIndex.reset();
        m_docHashIndexData.reset();

        m_docIdIndex.reset();
        m_docIdIndexData.reset();

        m_wordIdIndex.reset();
        m_wordIdIndexData.reset();

#ifdef KEEP_CASE_INDEX
        m_wordCaseIndex.reset();
        m_wordCaseIndexData.reset();
#endif

        m_wordNoCaseIndex.reset();
        m_wordNoCaseIndexData.reset();

        m_docMetadataWordIds.clear();

        m_stream.close();
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "index::db::Local";
    }

private:
    template <typename Index>
    static std::vector<uint32_t> lookupIds(
        bool isDoc, uint32_t id, const Index &index,
        const std::vector<uint32_t, memory::ViewAllocator<uint32_t>>
            &ids) noexcept {
        auto iter = index.find(id);
        if (iter == index.end()) return {};

        ASSERTD_MSG(iter->second.offset < ids.size(), "Looking up id", id,
                    "isDoc", isDoc, "Offset:", iter->second.offset, "Id size",
                    ids.size());

        auto compressedIds =
            memory::DataView{&ids.at(iter->second.offset), iter->second.size};

        // If count and size are equal, the ID's aren't compressed (presumably
        // because the AVX2 instruction set wasn't supported on the CPU where
        // the word DB was created) [DMS-536]
        if (iter->second.size == iter->second.count) {
            LOG(WordDb, "Word ID's are not compressed");
            return {compressedIds.begin(), compressedIds.end()};
        }

        // Count holds the decompressed size, reserve that much right away
        std::vector<uint32_t> decompressedIds;
        decompressedIds.resize(iter->second.count);

        // LOG(Local, "{} {,c} Decompressing {}", isDoc ? _ts("DOCID:", id) :
        // _ts("WORDID:", id), iter->second.count, compressedIds);

        // And decompress
        if (auto ccode = compress::inflate<compress::Type::FASTPFOR>(
                compressedIds, decompressedIds))
            dev::fatality(_location, "Failed to inflate ids", id, ccode);

        // LOG(Local, "{} {,c} Decompressed {}", isDoc ? _ts("DOCID:", id) :
        // _ts("WORDID:", id), iter->second.count, decompressedIds);

        return decompressedIds;
    }

    template <typename Type, typename Index>
    static PaginatedVector<Type> lookupIdsPaginated(
        bool isDoc, uint32_t id, const Index &index,
        const std::vector<uint32_t, memory::ViewAllocator<uint32_t>>
            &ids) noexcept {
        auto iter = index.find(id);
        if (iter == index.end()) return {};

        ASSERTD_MSG(iter->second.offset < ids.size(), "Looking up id", id,
                    "isDoc", isDoc, "Offset:", iter->second.offset, "Id size",
                    ids.size());

        typename PaginatedVectorWordDBDataSupplier<Type>::Pages pages;

        auto compressedSize = iter->second.size;
        auto uncompressedSize = iter->second.count;
        pages.emplace_back(&ids.at(iter->second.offset), compressedSize,
                           uncompressedSize);

        // construct and return paginated vector
        size_t pageSize = pages.size() > 0 ? std::get<2>(pages[0]) : 0;
        return PaginatedVector<Type>(
            pageSize,
            makeShared<PaginatedVectorWordDBDataSupplier<Type>,
                       typename PaginatedVectorWordDBDataSupplier<Type>::Pages>(
                _mv(pages)));
    }

    void load(const file::Path &path) noexcept(false) {
        LOGT("Reserving total {,s} memory for backing file {}", m_stream.size(),
             path);
        *m_stream.mapInit(*m_stream.size());

        // Align at a page boundary
        auto hdrSize = sizeof(tag::WordIndex);

        auto loadOffsets = [&]() -> auto & {
            auto loadFrom = *m_stream.size() - hdrSize;
            auto loadSize = hdrSize;

            LOGT(
                "Loading offsets header at reserved portion at offset: {,s} of "
                "page aligned size: {,s}",
                loadFrom, loadSize);

            m_hdrData.emplace(*m_stream.mapInputRange(loadFrom, loadSize));

            // Just cast it should be populated
            auto hdr = _reCast<tag::WordIndex *>(m_hdrData->allocate(hdrSize));

            // Sanity check
            hdr->__validate();

            // Assume its valid, place its reference in the hdr member, no
            // modification allowed though...
            return m_hdr.emplace(*hdr).get().offsets;
        };

        auto loadContainer = [&](auto name, auto &info, auto &data, auto &cnt) {
            LOGT("Loading", name, info);
            data.emplace(*m_stream.mapInputRange(info.offset, info.size));
            cnt.emplace(*data);
            cnt->resize(info.count);
        };

        auto loadIndex = [&](auto name, auto &info, auto &data, auto &cnt) {
            LOGT("Loading", name, info);
            data.emplace(*m_stream.mapInputRange(info.offset, info.size));
            cnt.emplace(fc::container_construct_t{}, *data);
            cnt->container.resize(info.count);
        };

        auto loadStringIndex = [&](auto name, auto &info, auto &data,
                                   auto &cnt) {
            LOGT("Loading", name, info);
            data.emplace(*m_stream.mapInputRange(info.offset, info.size));
            cnt.emplace(*m_wordStrings, fc::container_construct_t{}, *data);
            cnt->container.reserve(cnt->container.get_allocator().max_size());
            cnt->container.resize(info.count);
        };

        auto &offsets = loadOffsets();

        LOGT("Loaded offset header\n", offsets);

        loadContainer("DocWordIdLists", offsets.docWordIdLists,
                      m_docWordIdListsData, m_docWordIdLists);
        loadIndex("DocWordIdListIndex", offsets.docWordIdListIndex,
                  m_docWordIdListIndexData, m_docWordIdListIndex);

        loadContainer("WordDocIdSets", offsets.wordDocIdSets,
                      m_wordDocIdSetsData, m_wordDocIdSets);
        loadIndex("WordDocIdSetIndex", offsets.wordDocIdSetIndex,
                  m_wordDocIdSetIndexData, m_wordDocIdSetIndex);

        loadContainer("WordStrings", offsets.wordStrings, m_wordStringsData,
                      m_wordStrings);

        loadIndex("DocHashIndex", offsets.docHashIndex, m_docHashIndexData,
                  m_docHashIndex);
        loadIndex("DocIdIndex", offsets.docIdIndex, m_docIdIndexData,
                  m_docIdIndex);
        loadIndex("WordIdIndex", offsets.wordIdIndex, m_wordIdIndexData,
                  m_wordIdIndex);
#ifdef KEEP_CASE_INDEX
        loadStringIndex("WordCaseIndex", offsets.wordCaseIndex,
                        m_wordCaseIndexData, m_wordCaseIndex);
#endif
        loadStringIndex("WordNoCaseIndex", offsets.wordNoCaseIndex,
                        m_wordNoCaseIndexData, m_wordNoCaseIndex);

        LOGT("Stats", stats());
    }

    TextView lookupWordString(const ProxyWord &addr) const noexcept {
        ASSERT_MSG(m_wordStrings->size() >= addr.offset + addr.size,
                   "Invalid proxy word address", addr);
        ASSERT_MSG(addr.size != 0, "Invalid proxy word address length", addr);
        return {&m_wordStrings->operator[](addr.offset), addr.size};
    }

    Opt<memory::ViewAllocatorArena> m_hdrData;
    Opt<Ref<tag::WordIndex>> m_hdr;

    Opt<memory::ViewAllocatorArena> m_docWordIdListsData;
    Opt<WordIds<memory::ViewAllocator<WordId>>> m_docWordIdLists;

    Opt<memory::ViewAllocatorArena> m_docWordIdListIndexData;
    Opt<FlatDocWordIdListIndex<>> m_docWordIdListIndex;

    Opt<memory::ViewAllocatorArena> m_wordDocIdSetsData;
    Opt<DocIds<memory::ViewAllocator<DocId>>> m_wordDocIdSets;

    Opt<memory::ViewAllocatorArena> m_wordDocIdSetIndexData;
    Opt<FlatWordDocIdSetIndex<>> m_wordDocIdSetIndex;

    Opt<memory::ViewAllocatorArena> m_wordStringsData;
    Opt<WordStrings<memory::ViewAllocator<char>>> m_wordStrings;

    Opt<memory::ViewAllocatorArena> m_docHashIndexData;
    Opt<FlatDocHashIndex<>> m_docHashIndex;

    Opt<memory::ViewAllocatorArena> m_docIdIndexData;
    Opt<FlatDocIdIndex<>> m_docIdIndex;

    Opt<memory::ViewAllocatorArena> m_wordIdIndexData;
    Opt<FlatWordIdIndex<>> m_wordIdIndex;

#ifdef KEEP_CASE_INDEX
    Opt<memory::ViewAllocatorArena> m_wordCaseIndexData;
    Opt<FlatWordCaseIndex<>> m_wordCaseIndex;
#endif

    Opt<memory::ViewAllocatorArena> m_wordNoCaseIndexData;
    Opt<FlatWordNoCaseIndex<>> m_wordNoCaseIndex;

    file::FileStream m_stream;
    mutable DocMetadataIndex m_docMetadataWordIds;
    mutable async::MutexLock m_mutex;
};

}  // namespace engine::index::db::internal
