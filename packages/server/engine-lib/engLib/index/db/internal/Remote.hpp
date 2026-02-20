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

namespace engine::index::db::internal {

template <class Type>
using PaginatedVector = ap::memory::PaginatedVector<Type>;

// The remote mode of the word db, data is backed by a service and read
// on demand
class Remote {
public:
    _const auto LogLevel = Lvl::WordDb;

    // Formalize each section in the word index hdr offset table as enum types
    // if KEEP_CASE_INDEX is not defined and we don`t store the index itself
    // in the word index file we still keep the offsets table the old way
    // to keep backward compatibility. If we`re opening the old word index file
    // it will have OffsetTable with wordCaseIndex in it. So in order to read
    // the headers table correctly we need to know its size.
    // This is why we are not removing wordCaseIndex entry from headers table.
    APUTIL_DEFINE_ENUM_C(Section, 0, 11, DocWordIdLists = _begin,
                         DocWordIdListIndex, WordDocIdSets, WordDocIdSetIndex,
                         WordStrings, DocHashIndex, DocIdIndex, WordIdIndex,
                         WordCaseIndex, WordNoCaseIndex);

    // Each section above falls into one of three container types
    APUTIL_DEFINE_ENUM_C(Type, 0, 4, Container = _begin, Index, StringIndex);

    // Declare a container definition for one of the index sections above
    template <typename T, Section SecT>
    struct Container {
        _const auto Section = SecT;

        explicit operator bool() const noexcept { return loaded; }

        const auto* operator->() const noexcept {
            ASSERT(container);
            return &*container;
        }

        auto* operator->() noexcept {
            ASSERT(container);
            return &*container;
        }

        T& operator*() noexcept {
            ASSERT(container);
            return *container;
        }

        const T& operator*() const noexcept {
            ASSERT(container);
            return *container;
        }

        auto reset() noexcept {
            container.reset();
            arena.reset();
            data.reset();
            loaded = false;
        }

        // Destruction order matters here
        Opt<T> container;
        Opt<memory::ViewAllocatorArena> arena;
        Opt<Buffer> data;
        Atomic<bool> loaded{false};
    };

    Remote() noexcept(false) : m_mutex{makeShared<async::MutexLock>()} {}

    Remote(StreamPtr stream) noexcept(false) : Remote() { *open(_mv(stream)); }

    ~Remote() noexcept { close(); }

    TextView lookupWord(WordId id) const noexcept {
        // If it's a reserved word, render it
        if (auto word = renderReservedWordId(id)) return word;

        *loadContainer(m_wordIdIndex);
        if (auto iter = m_wordIdIndex->find(id); iter != m_wordIdIndex->end())
            return lookupWord(iter->second);

        // Shouldn't be possible otherwise
        ASSERT_MSG(!id, "Invalid word ID");
        return {};
    }

    TextView lookupWord(const ProxyWord& addr) const noexcept {
        *loadContainer(m_wordStrings);
        ASSERT_MSG(m_wordStrings->size() >= addr.offset + addr.size,
                   "Invalid proxy word address", addr);
        ASSERT_MSG(addr.size != 0, "Invalid proxy word address length", addr);
        return {&m_wordStrings->operator[](addr.offset), addr.size};
    }

    WordIdList lookupWordIds(iTextView word) const noexcept {
        WordIdList result;
        *loadContainer(m_wordNoCaseIndex);
        auto [start, end] = m_wordNoCaseIndex->equal_range(word);
        result.reserve(std::distance(start, end));
        util::transform(
            result, start, end,
            [&](auto addr, auto wordId) noexcept { return wordId; });
        return result;
    }

    WordId lookupWordId(TextView word) const noexcept {
#ifdef KEEP_CASE_INDEX
        *loadContainer(m_wordCaseIndex);
        if (auto iter = m_wordCaseIndex->find(word);
            iter != m_wordCaseIndex->end())
            return iter->second;
#else
        *loadContainer(m_wordNoCaseIndex);
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
        *loadContainer(m_wordDocIdSetIndex);
        *loadContainer(m_wordDocIdSets);
        return lookupIds(false, wordId, *m_wordDocIdSetIndex, *m_wordDocIdSets);
    }

    template <typename ContainerT,
              typename = std::enable_if<traits::IsContainerV<ContainerT>>>
    void lookupDocIds(WordId wordId, ContainerT& out) const noexcept {
        auto docIds = lookupDocIds(wordId);

        if (!docIds.empty()) _addTo(out, docIds);
    }

    DocId lookupDocId(const DocHash& hash) const noexcept {
        *loadContainer(m_docHashIndex);
        if (auto iter = m_docHashIndex->find(hash);
            iter != m_docHashIndex->end())
            return iter->second;
        return {};
    }

    Opt<DocHash> lookupDocHash(DocId docId) const noexcept {
        *loadContainer(m_docIdIndex);
        if (auto iter = m_docIdIndex->find(docId); iter != m_docIdIndex->end())
            return iter->second;
        return NullOpt;
    }

    bool hasDocId(DocId docId) const noexcept {
        *loadContainer(m_docWordIdListIndex);
        return m_docWordIdListIndex->find(docId) != m_docWordIdListIndex->end();
    }

    WordIdListReturnType lookupDocWordIdList(DocId docId) const noexcept {
        *loadContainer(m_docWordIdListIndex);

#if defined(TEST_WORD_ID_LIST)
        LOGT("lookupDocWordIdList: started to load non-paginated info");
#endif
#if !defined(USE_WORD_ID_LIST_PAGINATED) || defined(TEST_WORD_ID_LIST)
        *loadContainer(m_docWordIdLists);
        auto vectorResult =
            lookupIds(true, docId, *m_docWordIdListIndex, *m_docWordIdLists);
#endif
#if defined(TEST_WORD_ID_LIST)
        LOGT("lookupDocWordIdList: finished to load non-paginated info");
        LOGT("lookupDocWordIdList: default vector information: size={}",
             vectorResult.size());
        LOGT("lookupDocWordIdList: started to load paginated info");
#endif
#if defined(USE_WORD_ID_LIST_PAGINATED) || defined(TEST_WORD_ID_LIST)
        PaginatedWordIdList paginatedVectorResult =
            lookupIdsPaginated<WordId>(docId, *m_docWordIdListIndex);
#endif
#if defined(TEST_WORD_ID_LIST)
        size_t countEqual = 0;
        size_t countUnequal = 0;
        LOGT("lookupDocWordIdList: finished to load paginated info");
        LOGT(
            "lookupDocWordIdList: paginated info details: size={}, pageSize={}",
            paginatedVectorResult.size(), paginatedVectorResult.pageSize());
        LOGT("lookupDocWordIdList: Starting comparison");
        if (vectorResult.size() == paginatedVectorResult.size()) {
            LOGT("lookupDocWordIdList: sizes are equal");
            for (size_t index = 0; index < vectorResult.size(); ++index)
                if (vectorResult[index] == paginatedVectorResult[index]) {
                    // LOGT("lookupDocWordIdList: position {}: values are equal:
                    // vectorResult==paginatedVectorResult={}", index,
                    // paginatedVectorResult[index]);
                    ++countEqual;
                } else {
                    // LOGT("lookupDocWordIdList: position {}: values are NOT
                    // equal: vectorResult={}/paginatedVectorResult={}", index,
                    // vectorResult[index], paginatedVectorResult[index]);
                    ++countUnequal;
                }
        } else {
            LOGT("lookupDocWordIdList: sizes are NOT equal");
        }
        LOGT("Finishing comparison: equal = {}; not equal = {}", countEqual,
             countUnequal);
#endif
#if !defined(USE_WORD_ID_LIST_PAGINATED)
        return vectorResult;
#else
        return paginatedVectorResult;
#endif
    }

    template <typename T>
    void lookupDocMetadataWordIds(DocId id, T& cnt) const noexcept {
        cnt.clear();

        // Are the metadata words for this document already cached?
        auto lock = m_mutex->lock();
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
        auto& cachedMetadataWordIds = m_docMetadataWordIds[id];

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
        // if (auto ccode = metadata.load(*this, docId))
        // return ccode;
        return metadata;
    }

    auto docCount() const noexcept {
        *loadContainer(m_docWordIdListIndex);
        return m_docWordIdListIndex->size();
    }

    size_t docWordCount(DocId docId) const noexcept {
        *loadContainer(m_docWordIdListIndex);
        auto iter = m_docWordIdListIndex->find(docId);
        if (iter != m_docWordIdListIndex->end()) return iter->second.count;
        return {};
    }

    auto docWordCount() const noexcept {
        *loadContainer(m_docWordIdListIndex);
        size_t count = {};
        for (auto& [docId, wordIdListAddr] : *m_docWordIdListIndex)
            count += wordIdListAddr.count;
        return count;
    }

    auto wordCount() const noexcept {
        *loadContainer(m_wordNoCaseIndex);
        return m_wordNoCaseIndex->size();
    }

    auto uniqueWordCount() const noexcept {
#ifdef KEEP_CASE_INDEX
        *loadContainer(m_wordCaseIndex);
        return m_wordCaseIndex->size();
#else
        *loadContainer(
            m_wordNoCaseIndex);  // m_wordNoCaseIndex has same number of items
                                 // inside so it is equivalent
        return m_wordNoCaseIndex->size();
#endif
    }

    auto wordStringsSize() const noexcept {
        *loadContainer(m_wordStrings);
        return m_wordStrings->size();
    }

    auto& wordIdIndex() const noexcept {
        *loadContainer(m_wordIdIndex);
        return *m_wordIdIndex;
    }

#ifdef KEEP_CASE_INDEX
    auto& wordCaseIndex() const noexcept {
        *loadContainer(m_wordCaseIndex);
        return *m_wordCaseIndex;
    }
#endif

    auto& wordNoCaseIndex() const noexcept {
        *loadContainer(m_wordNoCaseIndex);
        return *m_wordNoCaseIndex;
    }

    auto& docIdIndex() const noexcept {
        *loadContainer(m_docIdIndex);
        return *m_docIdIndex;
    }

    auto& wordDocIdSetIndex() const noexcept {
        *loadContainer(m_wordDocIdSetIndex);
        return *m_wordDocIdSetIndex;
    }

    size_t docWordIdListCount(const DocHash& docHash) const noexcept {
        if (auto docId = lookupDocId(docHash)) return docWordCount(docId);
        return 0;
    }

    ErrorOr<Size> physicalSize() const noexcept {
        if (!m_stream) return APERR(Ec::NotOpen, "Not opened");
        return m_stream->size();
    }

    Stats stats() const noexcept {
        const auto physSize = physicalSize();

        return {.docCount = docCount(),
                .docWords = docWordCount(),
                .uniqueWords = uniqueWordCount(),
                .totalWords = wordCount(),
                .stringsSize = wordStringsSize(),
                .physicalSize = physSize ? *physSize : Size()};
    }

    Error open(StreamPtr stream) noexcept {
        if (m_stream)
            return APERRT(Ec::InvalidParam, "Already opened", m_stream);

        m_stream = _mv(stream);

        if (auto res = _call([&] { load(); }); res.check()) {
            m_stream->close();
            return res.ccode();
        }

        return {};
    }

    void close() noexcept {
        m_docWordIdLists.reset();
        m_docWordIdLists.reset();
        m_docWordIdListIndex.reset();
        m_wordDocIdSets.reset();
        m_wordDocIdSetIndex.reset();
        m_wordStrings.reset();
        m_docHashIndex.reset();
        m_docIdIndex.reset();
        m_wordIdIndex.reset();
#ifdef KEEP_CASE_INDEX
        m_wordCaseIndex.reset();
#endif
        m_wordNoCaseIndex.reset();
        m_docMetadataWordIds.clear();

        if (m_stream) {
            m_stream->close();
            m_stream.reset();
        }
    }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << "index::WordDbRead";
    }

private:
    template <typename Index>
    std::vector<uint32_t> lookupIds(
        bool isDoc, uint32_t id, const Index& index,
        const std::vector<uint32_t, memory::ViewAllocator<uint32_t>>& ids)
        const noexcept {
        auto iter = index.find(id);
        if (iter == index.end()) return {};

        ASSERTD_MSG(iter->second.offset < ids.size(), "Looking up id", id,
                    "isDoc", isDoc, "Offset:", iter->second.offset, "Id size",
                    ids.size());

        if (isDoc && iter->second.size ==
                         0)  // looking into document structure which is chunked
        {
            _const auto chunkLeadingBlockSize =
                2;  // {compressedSize, decompressedSize}
            auto currentOffset = &ids.at(iter->second.offset);

            // get leading block of first chunk
            memory::DataView chunkLeadingBlock{currentOffset,
                                               chunkLeadingBlockSize};

            size_t cursor = 0;
            size_t compressedSize = 0, uncompressedSize = 0;

            // Count holds elements count in decompressed doc struct, reserve
            // that much right away
            std::vector<WordId> fullDocStruct;
            fullDocStruct.resize(iter->second.count);

            _forever() {
                compressedSize = chunkLeadingBlock[0] / sizeof(WordId);
                uncompressedSize = chunkLeadingBlock[1] / sizeof(WordId);
                LOGT("Found chunk: compressed={}, uncompressed={}",
                     compressedSize, uncompressedSize);

                // means we found the control block {0, 0} which signals that
                // we`re done
                if (compressedSize == 0 && uncompressedSize == 0) {
                    return fullDocStruct;
                }

                // create DataView into current chunk, it can be compressed or
                // uncompressed
                memory::DataView compIds{currentOffset + chunkLeadingBlockSize,
                                         compressedSize};

                // create DataView into fullDocStruct of needed size
                // to uncompress or copy directly into fullDocStruct
                memory::DataView out{fullDocStruct.data() + cursor,
                                     uncompressedSize};

                if (compressedSize ==
                    uncompressedSize) {  // chunk is uncompressed => just copy
                    std::copy(compIds.begin(), compIds.end(), out.data());
                } else {  // chunk is compressed => decompress directly into
                          // fullDocStruct
                    if (auto ccode =
                            compress::inflate<compress::Type::FASTPFOR>(compIds,
                                                                        out))
                        dev::fatality(_location, "Failed to inflate ids", id,
                                      ccode);
                }

                // advance cursor for next iteration
                cursor += uncompressedSize;

                // advance to next control block
                currentOffset += chunkLeadingBlockSize + compressedSize;
                chunkLeadingBlock =
                    memory::DataView{currentOffset, chunkLeadingBlockSize};
            }
        }

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
        std::vector<WordId> decompressedIds;
        decompressedIds.resize(iter->second.count);

        // LOG(Remote, "{} {,c} Decompressing {}", isDoc ? _ts("DOCID:", id) :
        // _ts("WORDID:", id), iter->second.count, compressedIds);

        // And decompress
        if (auto ccode = compress::inflate<compress::Type::FASTPFOR>(
                compressedIds, decompressedIds))
            dev::fatality(_location, "Failed to inflate ids", id, ccode);

        // LOG(Remote, "{} {,c} Decompressed {}", isDoc ? _ts("DOCID:", id) :
        // _ts("WORDID:", id), iter->second.count, decompressedIds);

        return decompressedIds;
    }

    template <typename Type, typename Index>
    PaginatedVector<Type> lookupIdsPaginated(
        uint32_t id, const Index& index) const noexcept {
        auto iter = index.find(id);
        if (iter == index.end()) return {};

        // We need to lock the stream otherwise we end up crashing when reading
        // from multiple thread
        auto lock = m_mutex->lock();

        // Grab the offset info from the header for this section
        auto& info = offsetFromSection<Section::DocWordIdLists>();

        if (!info.size) {
            LOGT("Container is empty");
            return {};
        }

        using DataSupplier = LazyWordDBPaginatedVectorDataSupplier<Type>;
        using Pages = typename DataSupplier::Pages;
        using Page = typename Pages::value_type;

        Pages pages;

        size_t size = iter->second.size;

        size_t currentOffset =
            info.offset + (iter->second.offset * sizeof(WordId));

        if (!size)  // looking into document structure which is chunked
        {
            _const auto chunkLeadingBlockSize =
                2;  // {compressedSize, decompressedSize}

            WordIds<> chunkLeadingBlock;
            chunkLeadingBlock.resize(chunkLeadingBlockSize);

            auto outView =
                OutputData{_reCast<uint8_t*>(chunkLeadingBlock.data()),
                           chunkLeadingBlock.size() * sizeof(WordId)};

            _forever() {
                // jump right to needed offset in the worddb file and read the
                // chunk leading block
                if (auto res =
                        m_stream->tryReadAtOffset(currentOffset, outView);
                    res.check())
                    dev::fatality(_location,
                                  "Failed to read from remote word database",
                                  res.ccode());

                auto compressedSize = chunkLeadingBlock[0] / sizeof(WordId);
                auto uncompressedSize = chunkLeadingBlock[1] / sizeof(WordId);

                LOGT(
                    "Found ids (paginated, chunked): compressed={}, "
                    "uncompressed={}",
                    compressedSize, uncompressedSize);

                // means we found the control block {0, 0} which signals that
                // we`re done
                if (compressedSize == 0 && uncompressedSize == 0) {
                    break;
                }

                currentOffset += chunkLeadingBlockSize * sizeof(WordId);

                // add information about found chunk
                pages.push_back(
                    Page{currentOffset, compressedSize, uncompressedSize});

                // advance to next control block
                currentOffset += compressedSize * sizeof(WordId);
            }
        } else {
            auto compressedSize = size;
            auto uncompressedSize = iter->second.count;
            LOGT(
                "Found info (paginated, non-chunked): compressed={}, "
                "uncompressed={}",
                compressedSize, uncompressedSize);
            pages.push_back(
                Page{currentOffset, compressedSize, uncompressedSize});
        }

        // Free the lock as PaginatedVector might attempt to lock
        // the mutex and could cause a deadlock
        lock.unlock();

        // construct and return paginated vector
        size_t pageSize = pages.size() > 0 ? pages[0].uncompressedSize : 0;
        if (pages.size() > 1) {
            auto [minPageSizeIt, maxPageSizeIt] = std::minmax_element(
                pages.begin(),
                pages.end() - 1,  // consider all pages except the last one - it
                                  // might have different size
                [](const auto& l, const auto& r) -> bool {
                    return l.uncompressedSize < r.uncompressedSize;
                });
            size_t minPageSize = minPageSizeIt->uncompressedSize;
            size_t maxPageSize = maxPageSizeIt->uncompressedSize;
            if (minPageSize != maxPageSize)
                dev::fatality(_location,
                              "WordDB has different min and max page sizes:",
                              minPageSize, maxPageSize);
        }

        return PaginatedVector<Type>(
            pageSize,
            makeShared<DataSupplier, Pages>(_mv(pages), m_stream, m_mutex));
    }

    void load() noexcept(false) {
        LOGT("Opening remote word db", m_stream);

        // The offset header will be at the end
        m_stream->readAtOffset(m_stream->size() - sizeof(tag::WordIndex),
                               memory::viewCast(m_hdr));

        LOGT("Loaded offsets", m_hdr);
    }

    TextView lookupWordString(const ProxyWord& addr) const noexcept {
        ASSERT_MSG(m_wordStrings->size() >= addr.offset + addr.size,
                   "Invalid proxy word address", addr);
        ASSERT_MSG(addr.size != 0, "Invalid proxy word address length", addr);
        return {&m_wordStrings->operator[](addr.offset), addr.size};
    }

    template <typename ContainerT, Section SecT>
    Error loadContainer(Container<ContainerT, SecT>& cnt) const noexcept {
        // Check if already loaded
        if (cnt) return {};

        auto guard = m_mutex->lock();

        // Now that we locked, check again some other thread may have loaded it
        // by the time we acquired the lock
        if (cnt) return {};

        // Grab the offset info from the header for this section
        auto& info = offsetFromSection<SecT>();

        LOGT("Loading", cnt.Section, info);
        auto start = time::now();

        // Read the entire section in and setup its arena
        cnt.data.emplace(info.size);
        if (info.size) {
            if (auto res = m_stream->tryReadAtOffset(
                    info.offset, memory::viewCast(*cnt.data));
                res.check()) {
                MONERR(error, res.ccode(),
                       "Failed to read from remote word database");
                return res.ccode();
            }
            cnt.arena.emplace(memory::viewCast(*cnt.data), true);
        } else {
            LOGT("Container is empty");
            cnt.arena.emplace(OutputData());
        }

        // Derive a type from a section, each type has slightly different
        // instantiation semantics
        auto determineType = [] {
            // Got an exclusive lock now load it
            if constexpr (SecT == Section::DocWordIdLists ||
                          SecT == Section::WordDocIdSets ||
                          SecT == Section::WordStrings)
                return Type::Container;
            else if constexpr (SecT == Section::DocWordIdListIndex ||
                               SecT == Section::WordDocIdSetIndex ||
                               SecT == Section::DocHashIndex ||
                               SecT == Section::DocIdIndex ||
                               SecT == Section::WordIdIndex)
                return Type::Index;
            else
                return Type::StringIndex;
        };

        // Three different major container types
        if constexpr (determineType() == Type::Container) {
            cnt.container.emplace(*cnt.arena);
            cnt->resize(info.count);
        } else if constexpr (determineType() == Type::Index) {
            cnt.container.emplace(fc::container_construct_t{}, *cnt.arena);
            cnt->container.resize(info.count);
        } else {
            // String index is dependent on the word strings section, ensure its
            // loaded
            if (auto ccode = loadContainer(m_wordStrings)) return ccode;

            cnt.container.emplace(*m_wordStrings, fc::container_construct_t{},
                                  *cnt.arena);
            cnt->container.reserve(cnt->container.get_allocator().max_size());
            cnt->container.resize(info.count);
        }

        cnt.loaded = true;

        LOGT("Loaded", cnt.Section, info, "in", time::now() - start);

        return {};
    }

    // Fetch the offset for a section type
    template <Section SecT>
    const tag::WordIndex::Entry& offsetFromSection() const noexcept {
        // Got an exclusive lock now load it
        switch (SecT) {
            case Section::DocWordIdLists:
                return m_hdr.offsets.docWordIdLists;
            case Section::WordDocIdSets:
                return m_hdr.offsets.wordDocIdSets;
            case Section::WordStrings:
                return m_hdr.offsets.wordStrings;
            case Section::DocWordIdListIndex:
                return m_hdr.offsets.docWordIdListIndex;
            case Section::WordDocIdSetIndex:
                return m_hdr.offsets.wordDocIdSetIndex;
            case Section::DocHashIndex:
                return m_hdr.offsets.docHashIndex;
            case Section::DocIdIndex:
                return m_hdr.offsets.docIdIndex;
            case Section::WordIdIndex:
                return m_hdr.offsets.wordIdIndex;
            case Section::WordCaseIndex:
                return m_hdr.offsets.wordCaseIndex;
            case Section::WordNoCaseIndex:
                return m_hdr.offsets.wordNoCaseIndex;
            default:
                dev::fatality(_location, "Invalid section enum",
                              EnumIndex(SecT));
        }
    }

    // Lazily loaded mutable containers
    mutable Container<WordIds<memory::ViewAllocator<WordId>>,
                      Section::DocWordIdLists>
        m_docWordIdLists;
    mutable Container<FlatDocWordIdListIndex<>, Section::DocWordIdListIndex>
        m_docWordIdListIndex;
    mutable Container<DocIds<memory::ViewAllocator<DocId>>,
                      Section::WordDocIdSets>
        m_wordDocIdSets;
    mutable Container<FlatWordDocIdSetIndex<>, Section::WordDocIdSetIndex>
        m_wordDocIdSetIndex;
    mutable Container<WordStrings<memory::ViewAllocator<char>>,
                      Section::WordStrings>
        m_wordStrings;
    mutable Container<FlatDocHashIndex<>, Section::DocHashIndex> m_docHashIndex;
    mutable Container<FlatDocIdIndex<>, Section::DocIdIndex> m_docIdIndex;
    mutable Container<FlatWordIdIndex<>, Section::WordIdIndex> m_wordIdIndex;
#ifdef KEEP_CASE_INDEX
    mutable Container<FlatWordCaseIndex<>, Section::WordCaseIndex>
        m_wordCaseIndex;
#endif
    mutable Container<FlatWordNoCaseIndex<>, Section::WordNoCaseIndex>
        m_wordNoCaseIndex;

    StreamPtr m_stream;
    tag::WordIndex m_hdr;
    mutable DocMetadataIndex m_docMetadataWordIds;
    mutable async::MutexLockSharedPtr m_mutex;
};

}  // namespace engine::index::db::internal
