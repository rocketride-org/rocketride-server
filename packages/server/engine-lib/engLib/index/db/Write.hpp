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
// The write word db uses memory storage for speed and marshals out to a disk
// representation suitable for the read store to map instantly
template <>
class WordDb<file::Mode::WRITE> {
public:
    _const auto LogLevel = Lvl::WordDb;

    // Define a lock guard which articulates whether the caller has a shared or
    // unique lock on the db
    using LockTypeShared = async::SharedLock::SharedGuard;
    using LockTypeUnique = async::SharedLock::UniqueGuard;
    using LockGuard =
        std::variant<std::monostate, async::SharedLock::UniqueGuard,
                     async::SharedLock::SharedGuard>;

    // To avoid heap fragmentation, we use a slab allocator model, and this
    // defines the minimum allocation size shared across all the container types
    // in this instance
    _const auto SlabSize = 1_gb;

    WordDb() = default;
    ~WordDb() noexcept { deinit(false); }

    void setWordAddCallback(WordAddCallback cb = {}) noexcept {
        m_wordAddCallback = _mv(cb);
    }

    explicit operator bool() const noexcept { return _cast<bool>(m_stream); }

    bool getCompress() const noexcept { return m_compress; }

    void setCompress(bool value) noexcept { m_compress = value; }

    bool getKeepDocWordIds() const noexcept { return m_keepDocWordIds; }

    void setKeepDocWordIds(bool value) noexcept {
        ASSERTD_MSG(!value || !docCount(),
                    "Must be set prior to adding any documents");
        m_keepDocWordIds = value;
    }

    auto &normalizer() const noexcept { return *m_normalizer; }

    TextView lookupWord(WordId id) const noexcept {
        // If it's a reserved word, render it
        if (auto word = renderReservedWordId(id)) return word;

        if (auto iter = m_wordIdIndex->find(id); iter != m_wordIdIndex->end())
            return lookupWord(iter->second);
        return {};
    }

    WordId lookupWordId(TextView word) const noexcept {
        if (auto iter = m_wordCaseIndex->find(word);
            iter != m_wordCaseIndex->end())
            return iter->second;
        return {};
    }

    DocId lookupDocId(const DocHash &hash) const noexcept {
        if (auto iter = m_docHashIndex->find(hash);
            iter != m_docHashIndex->end())
            return iter->second;
        return {};
    }

    Opt<DocHash> lookupDocHash(DocId docId) const noexcept {
        if (auto iter = m_docIdIndex->find(docId); iter != m_docIdIndex->end())
            return iter->second.get();
        return NullOpt;
    }

    TextView lookupWord(const ProxyWord &addr) const noexcept {
        ASSERT_MSG(m_wordStrings->size() >= addr.offset + addr.size,
                   "Invalid proxy word address", addr);
        ASSERT_MSG(addr.size != 0, "Invalid proxy word address length", addr);
        return {&m_wordStrings->at(addr.offset), addr.size};
    }

    WordId addWord(TextView word, Opt<Ref<LockGuard>> guard = {}) noexcept {
        ASSERT(!word.empty());
        ASSERT_MSG(string::unicode::isValidUtf8(word),
                   "Invalid utf8 string added to word store",
                   memory::DataView{word});

        // See if its already known by its exact case
        if (auto iter = m_wordCaseIndex->find(word);
            iter != m_wordCaseIndex->end())
            return iter->second;
        const auto originalSize = m_wordCaseIndex->size();

        // Special check, if the word is 1 in length, and its value <
        // FirstWordId, then assign it that number
        WordId wordId;
        if (auto symbolId = normalizeSymbol(word))
            wordId = symbolId;
        else
            wordId = m_nextWordId++;
        ASSERT(isValidWordId(wordId));

        // Must upgrade to a write lock if a guard was handed to us - note
        // that for the newer pipe operations, this is called without a guard
        // since we are now using the m_wordLock to add an entire list. First,
        // we then don't have to continually upgrade/downgrade the lock, second
        // the entire document procesing is under the shared lock
        auto upgraded = false;
        if (guard && std::holds_alternative<LockTypeShared>(guard->get())) {
            // Release the shared, then grab the unique, not atomic but its
            // alright
            guard->get() = {};
            guard->get() = lock();
            upgraded = true;

            // May have been added since the upgrade is not atomic, check again
            if (originalSize != m_wordCaseIndex->size()) {
                if (auto iter = m_wordCaseIndex->find(word);
                    iter != m_wordCaseIndex->end())
                    return iter->second;
            }
        }

        auto addr = addWordToWordPack(word);

        // Keep a running total
        m_docWordCount++;

        // Can do these all at once
        [[maybe_unused]] auto inserted =
            m_wordCaseIndex->try_emplace(addr, wordId).second;
        ASSERTD_MSG(inserted, "Unexpected failure inserting word", word);

        // keep track of unique words
        ++m_uniqueWordCount;

        // when INDEX_LAZY_INIT is defined we`ll add new addr and word id only
        // into m_wordCaseIndex the other two indexes m_wordNoCaseIndex and
        // m_wordIdIndex will be recreated from contents of m_wordCaseIndex
        // right before writing them into word index file (see method close())
#ifndef INDEX_LAZY_INIT

        // Now add the wordId entry in the wordId index
        m_wordIdIndex->try_emplace(wordId, addr);

        // And associate it with an entry in the noCase map
        m_wordNoCaseIndex->insert(makePair(addr, wordId));

        // keep track of all the words
        ++m_wordCount;
#endif

        if (upgraded) {
            guard->get() = {};
            guard->get() = sharedLock();
        }

        return wordId;
    }

    DocId addDocId() noexcept {
        // Allocate a new doc ID
        return m_nextDocId++;
    }

    void setDocHash(DocId id, const DocHash &hash) noexcept {
        // Associate the doc ID with the doc hash
        auto [docHashIter, docHashInserted] =
            m_docHashIndex->try_emplace(hash, id);
        ASSERT_MSG(docHashInserted, "Unexpected failure inserting doc hash",
                   hash);

        // Associate the doc hash with the doc ID
        auto [docIdIter, docIdInserted] =
            m_docIdIndex->try_emplace(id, makeRef(docHashIter->first));
        ASSERT_MSG(docIdInserted, "Unexpected failure inserting doc ID", id);
    }

    DocId addDocHash(const DocHash &hash) noexcept {
        // Check if the doc hash already exists
        if (auto id = lookupDocId(hash)) return id;

        // Allocate a new doc ID
        auto docId = addDocId();
        ASSERT(docId);

        // Associate the doc ID and doc hash with each other
        setDocHash(docId, hash);

        return docId;
    }

    DocId addDocHashFirst(const DocHash &hash) noexcept {
        // Check if the doc hash already exists
        if (lookupDocId(hash)) return {};

        // Add the doc hash
        return addDocHash(hash);
    }

    size_t docCount() const noexcept {
        // return m_docWordIdListIndex->size();
        return m_docCount;
    }

    auto docWordCount() const noexcept { return m_docWordCount; }

    auto wordCount() const noexcept {
        // return m_wordNoCaseIndex->size();
        return m_wordCount;
    }

    auto uniqueWordCount() const noexcept {
        // return m_wordCaseIndex->size();
        return m_uniqueWordCount;
    }

    auto wordStringsSize() const noexcept { return m_wordStrings->size(); }

    bool operator==(const WordDb &db) const noexcept {
        return *m_wordStrings == *db.m_wordStrings;
    }

    auto &wordIdIndex() const noexcept { return *m_wordIdIndex; }

    auto &wordCaseIndex() const noexcept { return *m_wordCaseIndex; }

    auto &wordNoCaseIndex() const noexcept { return *m_wordNoCaseIndex; }

    ErrorOr<Size> physicalSize() const noexcept {
        if (m_stream) return m_stream.get()->size();
        return APERRT(Ec::NotOpen, "Not opened");
    }

    Stats stats(bool force = false) const noexcept {
        // Use cached stats if available
        if (m_stats && !force) return *m_stats;

        auto physSize = physicalSize();

        return {.docCount = docCount(),
                .docWords = docWordCount(),
                .uniqueWords = uniqueWordCount(),
                .totalWords = wordCount(),
                .stringsSize = wordStringsSize(),
                .physicalSize = physSize ? *physSize : Size()};
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "index::WordDbWrite";
    }

    auto wordLock() const noexcept { return m_wordLock.acquire(); }

    // Pipes no longer use this locking. It must be outside
    // of the word database itself since when we copy it to
    // write it, the m_lock would be copied and never
    // signalled
    LockGuard sharedLock() const noexcept { return m_lock.shared(); }

    LockGuard lock() const noexcept { return m_lock.acquire(); }

    // Put two versions of Error close(bool graceful = true) noexcept
    // method here. One used with bucket array, other with streaming
    // wordDocIds to disk and gather them later into the same large buffer
#ifdef USE_SLIDING_WINDOW

    //-----------------------------------------------------------------
    /// @details
    ///		This method processes current segment of inverted index
    ///		It sorts segment, throws duplicates away, writes it out
    ///		into file on disk and creates new entry in segments control table.
    ///		After all done it clears current segment.
    ///	@returns
    ///		Error
    //-----------------------------------------------------------------
    Error processIISegment() noexcept {
        if (m_invertedIndexSegment.empty()) return {};

        // sort m_invertedIndexSegment
        std::sort(m_invertedIndexSegment.begin(), m_invertedIndexSegment.end(),
                  IIEntryComparator);

        // remove adjacent repeating elements and shrink vector
        auto last = std::unique(m_invertedIndexSegment.begin(),
                                m_invertedIndexSegment.end());
        m_invertedIndexSegment.erase(last, m_invertedIndexSegment.end());

        // create new entry for control table
        ControlTableEntry entry;
        entry.entriesCount = m_invertedIndexSegment.size();
        entry.segmentSizeBytes =
            m_invertedIndexSegment.size() * sizeof(IIEntry);
        entry.segmentOffset = m_segmentsFile.size();

        // Create data view into current segment
        auto data =
            InputData{_reCast<const uint8_t *>(m_invertedIndexSegment.data()),
                      entry.segmentSizeBytes};

        // Write it to the overflow buffer
        if (auto ccode = m_segmentsFile.writeData(data)) return ccode;

        // if write successfull add new entry into table
        m_segmentsControlTable.push_back(entry);

        // clear contents of m_invertedIndexSegment leaving its capacity and
        // allocated memory untouched
        m_invertedIndexSegment.clear();

        LOGT(
            "Inverted index segment written to file. Segments so far: {}  "
            "Number of entries in current segment: {}",
            m_segmentsControlTable.size(), entry.entriesCount);

        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		This method returns pointer to requested entry in a given segment
    ///		or nullptr if requested entry is out of bound for current segment.
    ///		In the first place it looks if requested entry is loaded already
    /// from 		the file and resides in the memory within our large buffer.
    /// If it is 		not there it loads new chunk of current segment from
    /// file into buffer.
    ///	@param[in]	segmentId
    ///		Id of the segment we are looking into
    ///	@param[in]	virtualEntry
    ///		The entry number within current segment
    ///	@returns
    ///		Error
    //-----------------------------------------------------------------
    inline ErrorOr<IIEntry *> getEntry(size_t segmentId,
                                       size_t virtualEntry) noexcept {
        // sanity checks
        if (segmentId >= m_segmentsControlTable.size()) return nullptr;

        // If we have hit the end, then return null
        if (virtualEntry >= m_segmentsControlTable[segmentId].entriesCount)
            return nullptr;

        // If it is within what we have buffered, return its buffer location
        if (virtualEntry >= m_segmentsControlTable[segmentId].chunkOffset &&
            virtualEntry < m_segmentsControlTable[segmentId].chunkOffset +
                               m_chunkEntries) {
            return (m_invertedIndexSegment.data() + segmentId * m_chunkEntries +
                    virtualEntry -
                    m_segmentsControlTable[segmentId].chunkOffset);
        }

        // We have to read it from disk - determine how much we can read
        size_t readEntries = m_chunkEntries;
        if (virtualEntry + readEntries >
            m_segmentsControlTable[segmentId].entriesCount)
            readEntries =
                m_segmentsControlTable[segmentId].entriesCount - virtualEntry;

        // Now read it into segments element[0], at the offset of the vitual
        // entry specified
        size_t readEntriesByteSize = readEntries * sizeof(IIEntry);
        OutputData outData{_reCast<uint8_t *>(m_invertedIndexSegment.data() +
                                              segmentId * m_chunkEntries),
                           readEntriesByteSize};

        auto res = m_segmentsFile.readData(
            m_segmentsControlTable[segmentId].segmentOffset +
                virtualEntry * sizeof(IIEntry),
            outData);

        // check if read was successfull
        if (res.hasCcode()) return res.ccode();

        // Update the window on where we are at
        m_segmentsControlTable[segmentId].chunkOffset = virtualEntry;

        // Since we read virtaulEntry into element[0], return its address
        return m_invertedIndexSegment.data() + segmentId * m_chunkEntries;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		This method prepares our large buffer for merge sort phase as well
    /// as 		initializes some valuable variables for further usage. 		It
    /// computes how much entries from each segment we can read into buffer,
    /// reads this chunk from each segment and puts these chunks into buffer.
    ///	@returns
    ///		Error
    //-----------------------------------------------------------------
    Error prepareMergeBuffer() noexcept {
        // there must be at least 1 segment to proceed
        m_segmentsCount = m_segmentsControlTable.size();
        if (m_segmentsCount == 0) return {};

        // prepare our buffer for merge step: clear and resize to its initial
        // capacity
        m_invertedIndexSegment.clear();
        m_invertedIndexSegment.resize(m_invertedIndexSegment.capacity());

        // should not happen if buffer is large enough
        if (m_segmentsCount > m_iiEntriesCount)
            return APERRT(Ec::Unexpected,
                          "Segments count more than capacity of buffer to read "
                          "into. Segments chunks won`t fit");

        // Determine the number of entries from each segment we can put into the
        // buffer at once Since m_segmentsCount <= m_iiEntriesCount here we`ll
        // get m_chunkEntries at least equals to 1 so no need to check for 0
        m_chunkEntries = m_iiEntriesCount / m_segmentsCount;

        // Initalize by reading the first chunk of every segment
        for (size_t segmentId = 0; segmentId < m_segmentsCount; ++segmentId) {
            // Determine how much we can read in each segment
            // the last segment may not contain m_iiEntriesCount elements
            size_t readEntries = std::min(
                m_chunkEntries, m_segmentsControlTable[segmentId].entriesCount);

            // create data view into m_invertedIndexSegment at the exact place
            // to read into it readEntries
            size_t readEntriesByteSize = readEntries * sizeof(IIEntry);
            OutputData outData{
                _reCast<uint8_t *>(m_invertedIndexSegment.data() +
                                   segmentId * m_chunkEntries),
                readEntriesByteSize};

            // read first chunk of every segment
            auto res = m_segmentsFile.readData(
                m_segmentsControlTable[segmentId].segmentOffset, outData);

            // check if read was successfull
            if (res.hasCcode()) return res.ccode();
        }

        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		This method returns pointer to requested entry in a given segment
    ///		or nullptr if requested entry is out of bound for current segment.
    ///		In the first place it looks if requested entry is loaded already
    /// from 		the file and resides in the memory within our large buffer.
    /// If it is 		not there it loads new chunk of current segment from
    /// file into buffer.
    ///	@param[in]	segmentId
    ///		Id of the segment we are looking into
    ///	@param[in]	virtualEntry
    ///		The entry number within current segment
    ///	@returns
    ///		Error
    //-----------------------------------------------------------------
    inline Error mergeSegments(WordId wordId,
                               std::vector<DocId> &docIdList) noexcept {
        // reset list and tracking variable
        IIEntry *pEntry = nullptr;
        docIdList.clear();

        // This variable will hold the last doc id added into docIdList to omit
        // inserting duplicates
        DocId lastAddedDoc = 0;

        // Examine each segment to see if we have the next document contains the
        // word we are outputting
        for (size_t segmentId = 0; segmentId < m_segmentsCount; ++segmentId) {
            auto res = getEntry(segmentId,
                                m_segmentsControlTable[segmentId].entryOffset);

            if (res.hasCcode()) return res.ccode();

            pEntry = res.value();
            if (!pEntry || pEntry->wordId != wordId) continue;

            // The chunk contains the docId/wordId we are looking for, so save
            // it As long as FirstDocId = 1 we can just check for one condition
            // if starting lastAddedDoc from 0
            if (pEntry->docId != lastAddedDoc) {
                docIdList.emplace_back(pEntry->docId);
                lastAddedDoc = pEntry->docId;
            }

            // Now remove the word we just output and all its duplicates
            while (true) {
                // Advance to the next entry in the segment
                m_segmentsControlTable[segmentId].entryOffset++;

                // Get the next entry. If it is not the word we are outputting
                // then we can move on. This handles duplicates
                auto res = getEntry(
                    segmentId, m_segmentsControlTable[segmentId].entryOffset);

                if (res.hasCcode()) return res.ccode();

                pEntry = res.value();
                if (!pEntry || pEntry->wordId != wordId) break;

                // Here we still stay on the same word id. If not we`d break on
                // previous line. If within current word id we find new doc id
                // then save it
                if (pEntry->docId != lastAddedDoc) {
                    docIdList.emplace_back(pEntry->docId);
                    lastAddedDoc = pEntry->docId;
                }
            }
        }

        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		This method compresses and writes into word index file list of
    /// compressed 		or uncompressed document ids for particular word id.
    ///	@param[in]	wordId
    ///		Id of the word we are processing
    ///	@param[in]	docIds
    ///		Vector of document ids where this word id presented (inverted index)
    ///	@param[in]	baseOffset
    ///		Reference to a variable holding offset where we start writing doc
    /// ids 		in word index file
    ///	@param[in]	offsets
    ///		Reference to offsets table to update it
    ///	@param[in]	wordDocIdSetIndex
    ///		Container where we will put additional information about each
    ///		doc ids list we wrote into word index file
    ///	@returns
    ///		Error
    //-----------------------------------------------------------------
    Error compressAndWriteDocIds(
        WordId wordId, std::vector<DocId> &docIds, size_t &baseOffset,
        tag::WordIndex::OffsetTable &offsets,
        FlatWordDocIdSetIndex<std::allocator> &wordDocIdSetIndex) noexcept {
        // do not process empty doc id list
        if (docIds.empty()) return {};

        auto docIdsSize = docIds.size();

        // Compress these guys too
        memory::SmallArena<WordId> arena;
        std::vector<WordId, memory::SmallAllocator<WordId>> compressedDocIds{
            arena};

        // Compress the doc ID's
        ErrorOr<Opt<size_t>> originalSizeOr =
            compressIds(docIds, compressedDocIds);

        if (!originalSizeOr) return originalSizeOr.ccode();

        Opt<size_t> originalSize = *originalSizeOr;

        ASSERT_MSG(!originalSize || compressedDocIds.size() != docIdsSize,
                   "Compressed doc ID's are the same size as the original "
                   "(ambiguous)");
        if (originalSize) {
            ProxyDocIdSet addr{.offset = baseOffset,
                               .size = _nc<uint32_t>(compressedDocIds.size()),
                               .count = _nc<uint32_t>(*originalSize)};

            if (auto ccode =
                    m_stream->tryWrite(memory::viewCast(compressedDocIds)))
                return ccode;

            // Update the entry info for the sets as we go along
            offsets.wordDocIdSets.count += compressedDocIds.size();
            offsets.wordDocIdSets.size +=
                compressedDocIds.size() * sizeof(DocId);
            baseOffset += compressedDocIds.size();

            // Point to the position of the sorted set we just wrote on the
            // stream position
            wordDocIdSetIndex[wordId] = addr;
        } else {
            // Proceed without compression (same size and count will signal that
            // the word ID's are not compressed)
            ProxyDocIdSet addr{.offset = baseOffset,
                               .size = _nc<uint32_t>(docIdsSize),
                               .count = _nc<uint32_t>(docIdsSize)};

            if (auto ccode = m_stream->tryWrite(memory::viewCast(docIds)))
                return ccode;

            // Update the entry info for the sets as we go along
            offsets.wordDocIdSets.count += docIdsSize;
            offsets.wordDocIdSets.size += docIdsSize * sizeof(DocId);
            baseOffset += docIdsSize;

            // Point to the position of the sorted set we just wrote on the
            // stream position
            wordDocIdSetIndex[wordId] = addr;
        }

        docIds.clear();

        return {};
    }

    Error close(bool graceful = true) noexcept {
        LOGT("Closing");

        if (!m_stream) return APERRT(Ec::InvalidParam, "Not opened");

        // sort, write and clear leftovers of m_invertedIndexSegment here (tail
        // part)
        if (auto ccode = processIISegment()) return ccode;

        // init merge buffer and other variables before merge sort phase
        if (auto ccode = prepareMergeBuffer()) return ccode;

        const auto start = time::now();

        auto writeEntry =
            [&](auto &info, auto &cnt, Opt<Function<Error()>> write = {},
                Opt<Function<size_t()>> size = {}) noexcept -> Error {
            // Begin by aligning up to a page boundary
            if (auto ccode = m_stream->tryWriteAlign()) return ccode;

            // Now write the container using its allocator to determine its size
            // type
            info.offset = m_stream->offset();
            info.count = cnt.size();
            auto allocator = cnt.get_allocator();
            size_t valueTypeSize;
            if (size)
                valueTypeSize = (*size)();
            else
                valueTypeSize =
                    sizeof(typename decltype(allocator)::value_type);
            info.size = alignUp(info.count * valueTypeSize, plat::pageSize());

            if (write) {
                if (auto ccode = (*write)()) return ccode;
            } else {
                if constexpr (traits::IsVectorV<decltype(cnt)>) {
                    if (auto ccode = m_stream->tryWrite(
                            {_reCast<const uint8_t *>(cnt.data()),
                             cnt.size() * valueTypeSize}))
                        return ccode;
                } else {
                    for (auto &e : cnt) {
                        if (auto ccode = m_stream->tryWrite(
                                {_reCast<const uint8_t *>(&e), valueTypeSize}))
                            return ccode;
                    }
                }
            }

            // Pad to a page boundary for the next section
            return m_stream->tryWriteAlign();
        };

        tag::WordIndex hdr;
        auto &offsets = hdr.offsets;

        //
        // DocWordIdLists
        //
        offsets.docWordIdLists.offset = 0;
        offsets.docWordIdLists.size = m_stream->offset();
        offsets.docWordIdLists.count = m_stream->offset() / sizeof(WordId);

        // Write to a page boundary to start a new section just after the
        // docWordIdLists we've already written at this point
        if (auto ccode = m_stream->tryWriteAlign()) return ccode;

        //
        // DocWordIdListIndex
        //
        if (auto ccode =
                writeEntry(offsets.docWordIdListIndex, *m_docWordIdListIndex))
            return ccode;

        //
        // WordDocIdSets
        //
        offsets.wordDocIdSets.offset = m_stream->offset();
        offsets.wordDocIdSets.count = {};
        offsets.wordDocIdSets.size = {};

        // Since we are recording proxy offsets, they need to be relative to
        // a vector, with a position based off a size, start at zero
        size_t baseOffset = 0;

        {  // create internal scope to clear temp objects when they`re out of
           // scope

            // Prepare a flat data structure on the heap which is our
            // wordDocIdSetIndex next we will prepare this from the wordDocIdSet
            // index
            FlatWordDocIdSetIndex<std::allocator> wordDocIdSetIndex;

            // Vector that would contain all the doc ids for current word id
            // Allocate it upfront by the total number of indexed documents
            std::vector<DocId> docIdList;
            docIdList.reserve(m_docCount);

            LOGT("Start merge segments...");

            // Loop through outputting all the words
            for (WordId wordId = 1; wordId <= m_nextWordId; wordId++) {
                if (auto ccode = mergeSegments(wordId, docIdList)) return ccode;

                if (docIdList.empty()) continue;

                if (auto ccode =
                        compressAndWriteDocIds(wordId, docIdList, baseOffset,
                                               offsets, wordDocIdSetIndex))
                    return ccode;
            }

            LOGT("Go to reserved word ids...");

            // One more cycle for reserved word ids
            for (WordId wordId = FirstReservedWordId; wordId < MaxValue<WordId>;
                 wordId++) {
                if (auto ccode = mergeSegments(wordId, docIdList)) return ccode;

                if (docIdList.empty()) continue;

                if (auto ccode =
                        compressAndWriteDocIds(wordId, docIdList, baseOffset,
                                               offsets, wordDocIdSetIndex))
                    return ccode;
            }

            LOGT("Finish merge segments");

            //
            // WordDocIdSetIndex, WordStrings, DocHashIndex, DocIdIndex
            //
            if (auto ccode =
                    (writeEntry(offsets.wordDocIdSetIndex,
                                wordDocIdSetIndex.container) ||
                     writeEntry(offsets.wordStrings, *m_wordStrings) ||
                     writeEntry(offsets.docHashIndex, *m_docHashIndex) ||

                     // DocIdIndex has a ref so handle it special
                     writeEntry(
                         offsets.docIdIndex, *m_docIdIndex,
                         [this]() noexcept -> Error {
                             for (auto &[docId, hashRef] : *m_docIdIndex) {
                                 auto entry = makePair(docId, hashRef.get());
                                 if (auto ccode = m_stream->tryWrite(
                                         memory::viewCast(entry)))
                                     return ccode;
                             }
                             return {};
                         },
                         [] { return sizeof(Pair<DocId, DocHash>); })))
                return ccode;

        }  // close internal scope to clear temp objects when they`re out of
           // scope

        LOGT("Releasing unneeded containers");

#ifdef INDEX_LAZY_INIT
        // first reset already written indexes and release their memory
#ifndef USE_SLIDING_WINDOW
        m_wordDocIdSetIndex.reset();
#endif
        m_docHashIndex.reset();
        m_docIdIndex.reset();
        m_docMetadataWordIds.reset();
        m_docWordIdListIndex.reset();

        m_monoRes.release();

        LOGT("Start lazy init...");

        // now insert all the items from m_wordCaseIndex into m_wordNoCaseIndex
        // call merge() to omit allocating new memory. Instead of allocating
        // new memory and copy values into it, it reorders values
        // from m_wordCaseIndex using same memory. After that m_wordCaseIndex
        // becomes invalid so beware not to use it anywhere or UB guaranteed
        m_wordNoCaseIndex->merge(*m_wordCaseIndex);

        // keep track of all the words
        m_wordCount = m_wordNoCaseIndex->size();

        // now put all values from m_wordNoCaseIndex into m_wordIdIndex
        for (auto &[proxyWord, wordId] : *m_wordNoCaseIndex) {
            m_wordIdIndex->try_emplace(wordId, proxyWord);
        }

        LOGT("Finish lazy init");
        // finally write created indexes into word index file...
#endif

        //
        // WordIdIndex
        //
        if (auto ccode = writeEntry(offsets.wordIdIndex, *m_wordIdIndex))
            return ccode;

        //
        // Proxy collator types WordCaseIndex, WordNoCaseIndex
        //
#ifdef KEEP_CASE_INDEX
        // write m_wordCaseIndex into word index file is
        // possible only without lazy init for indexes because
        // if we use index lazy init model by this point in code
        // m_wordCaseIndex will be already invalid because of
        // merge() method has been called to create m_wordNoCaseIndex
        // using same memory (see comments few lines above)
#ifndef INDEX_LAZY_INIT
        if (auto ccode = (writeEntry(offsets.wordCaseIndex, *m_wordCaseIndex)))
            return ccode;
#endif
#endif
        if (auto ccode =
                writeEntry(offsets.wordNoCaseIndex, *m_wordNoCaseIndex))
            return ccode;

        LOGT("Final header offsets", offsets);

        // Finally we can now write the header itself, everything should be
        // ready to go for a memory mapped re-hydration of this file when the
        // SearchBatch job is used
        if (auto ccode = m_stream->tryWrite(hdr)) return ccode;

        // Close the stream and get final stats
        if (auto ccode = finalize()) return ccode;

        LOGT("Successfully closed word DB in", time::now() - start, "of size",
             m_stats->physicalSize);

        deinit(true);

        return {};
    }
#else
    Error close(bool graceful = true) noexcept {
        LOGT("Closing");

        if (!m_stream) return APERRT(Ec::InvalidParam, "Not opened");

        const auto start = time::now();

        auto writeEntry =
            [&](auto &info, auto &cnt, Opt<Function<Error()>> write = {},
                Opt<Function<size_t()>> size = {}) noexcept -> Error {
            // Begin by aligning up to a page boundary
            if (auto ccode = m_stream->tryWriteAlign()) return ccode;

            // Now write the container using its allocator to determine its size
            // type
            info.offset = m_stream->offset();
            info.count = cnt.size();
            auto allocator = cnt.get_allocator();
            size_t valueTypeSize;
            if (size)
                valueTypeSize = (*size)();
            else
                valueTypeSize =
                    sizeof(typename decltype(allocator)::value_type);
            info.size = alignUp(info.count * valueTypeSize, plat::pageSize());

            if (write) {
                if (auto ccode = (*write)()) return ccode;
            } else {
                if constexpr (traits::IsVectorV<decltype(cnt)>) {
                    if (auto ccode = m_stream->tryWrite(
                            {_reCast<const uint8_t *>(cnt.data()),
                             cnt.size() * valueTypeSize}))
                        return ccode;
                } else {
                    for (auto &e : cnt) {
                        if (auto ccode = m_stream->tryWrite(
                                {_reCast<const uint8_t *>(&e), valueTypeSize}))
                            return ccode;
                    }
                }
            }

            // Pad to a page boundary for the next section
            return m_stream->tryWriteAlign();
        };

        tag::WordIndex hdr;
        auto &offsets = hdr.offsets;

        //
        // DocWordIdLists
        //
        offsets.docWordIdLists.offset = 0;
        offsets.docWordIdLists.size = m_stream->offset();
        offsets.docWordIdLists.count = m_stream->offset() / sizeof(WordId);

        // Write to a page boundary to start a new section just after the
        // docWordIdLists we've already written at this point
        if (auto ccode = m_stream->tryWriteAlign()) return ccode;

        //
        // DocWordIdListIndex
        //
        if (auto ccode =
                writeEntry(offsets.docWordIdListIndex, *m_docWordIdListIndex))
            return ccode;

        //
        // WordDocIdSets
        //
        offsets.wordDocIdSets.offset = m_stream->offset();
        offsets.wordDocIdSets.count = {};
        offsets.wordDocIdSets.size = {};

        // Since we are recording proxy offsets, they need to be relative to
        // a vector, with a position based off a size, start at zero
        size_t baseOffset = 0;

        {  // create internal scope to clear temp objects when they`re out of
           // scope

#ifdef USE_BUCKET_ARRAY create buffer long enough to hold contents of any docIds
            auto longestDocIds = (*m_wordDocIdSetIndex).getLongestSize();
            std::vector<DocId> copyBuffer;
            copyBuffer.resize(longestDocIds);
#endif

            // Prepare a flat data structure on the heap which is our
            // wordDocIdSetIndex next we will prepare this from the wordDocIdSet
            // index
            FlatWordDocIdSetIndex<std::allocator> wordDocIdSetIndex;

#ifdef USE_BUCKET_ARRAY
            auto iter = (*m_wordDocIdSetIndex).enumerate();
            while (iter) {
                auto val = *iter;
                auto wordId = val.first;

                copyBuffer.resize(longestDocIds);

                size_t i = 0;
                auto node = val.second->first;
                while (node) {
                    copyBuffer[i] = node->data;
                    node = node->pNext;
                    ++i;
                }
                copyBuffer.resize(i);
                auto docIdsSize = i;
#else
            for (auto &[wordId, docIds] : *m_wordDocIdSetIndex) {
                auto docIdsSize = docIds.size();
#endif

                // Compress these guys too
                memory::SmallArena<WordId> arena;
                std::vector<WordId, memory::SmallAllocator<WordId>>
                    compressedDocIds{arena};

                // Compress the doc ID's
#ifdef USE_BUCKET_ARRAY
                ErrorOr<Opt<size_t>> originalSizeOr =
                    compressIds(copyBuffer, compressedDocIds);
#else
                ErrorOr<Opt<size_t>> originalSizeOr =
                    compressIds(docIds.container, compressedDocIds);
#endif
                if (!originalSizeOr) return originalSizeOr.ccode();

                Opt<size_t> originalSize = *originalSizeOr;

                ASSERT_MSG(
                    !originalSize || compressedDocIds.size() != docIdsSize,
                    "Compressed doc ID's are the same size as the original "
                    "(ambiguous)");
                if (originalSize) {
                    ProxyDocIdSet addr{
                        .offset = baseOffset,
                        .size = _nc<uint32_t>(compressedDocIds.size()),
                        .count = _nc<uint32_t>(*originalSize)};

                    if (auto ccode = m_stream->tryWrite(
                            memory::viewCast(compressedDocIds)))
                        return ccode;

                    // Update the entry info for the sets as we go along
                    offsets.wordDocIdSets.count += compressedDocIds.size();
                    offsets.wordDocIdSets.size +=
                        compressedDocIds.size() * sizeof(DocId);
                    baseOffset += compressedDocIds.size();

                    // Point to the position of the sorted set we just wrote on
                    // the stream position
                    wordDocIdSetIndex[wordId] = addr;
                } else {
                    // Proceed without compression (same size and count will
                    // signal that the word ID's are not compressed)
                    ProxyDocIdSet addr{.offset = baseOffset,
                                       .size = _nc<uint32_t>(docIdsSize),
                                       .count = _nc<uint32_t>(docIdsSize)};

#ifdef USE_BUCKET_ARRAY
                    if (auto ccode =
                            m_stream->tryWrite(memory::viewCast(copyBuffer)))
                        return ccode;
#else
                    if (auto ccode = m_stream->tryWrite(
                            memory::viewCast(docIds.container)))
                        return ccode;
#endif

                    // Update the entry info for the sets as we go along
                    offsets.wordDocIdSets.count += docIdsSize;
                    offsets.wordDocIdSets.size += docIdsSize * sizeof(DocId);
                    baseOffset += docIdsSize;

                    // Point to the position of the sorted set we just wrote on
                    // the stream position
                    wordDocIdSetIndex[wordId] = addr;
                }

#ifdef USE_BUCKET_ARRAY
                ++iter;
#else
                docIds.clear();
#endif
            }

#ifndef USE_BUCKET_ARRAY
            m_wordDocIdSetIndex->clear();
#endif

            //
            // WordDocIdSetIndex, WordStrings, DocHashIndex, DocIdIndex
            //
            if (auto ccode =
                    (writeEntry(offsets.wordDocIdSetIndex,
                                wordDocIdSetIndex.container) ||
                     writeEntry(offsets.wordStrings, *m_wordStrings) ||
                     writeEntry(offsets.docHashIndex, *m_docHashIndex) ||

                     // DocIdIndex has a ref so handle it special
                     writeEntry(
                         offsets.docIdIndex, *m_docIdIndex,
                         [this]() noexcept -> Error {
                             for (auto &[docId, hashRef] : *m_docIdIndex) {
                                 auto entry = makePair(docId, hashRef.get());
                                 if (auto ccode = m_stream->tryWrite(
                                         memory::viewCast(entry)))
                                     return ccode;
                             }
                             return {};
                         },
                         [] { return sizeof(Pair<DocId, DocHash>); })))
                return ccode;

        }  // close internal scope to clear temp objects when they`re out of
           // scope

        LOGT("Releasing unneeded containers");

#ifdef INDEX_LAZY_INIT
        // first reset already written indexes and release their memory
#ifndef USE_SLIDING_WINDOW
        m_wordDocIdSetIndex.reset();
#endif
        m_docHashIndex.reset();
        m_docIdIndex.reset();
        m_docMetadataWordIds.reset();
        m_docWordIdListIndex.reset();

        m_monoRes.release();

        LOGT("Start lazy init...");

        // now insert all the items from m_wordCaseIndex into m_wordNoCaseIndex
        // call merge() to omit allocating new memory. Instead of allocating
        // new memory and copy values into it it reorders values
        // from m_wordCaseIndex using same memory. After that m_wordCaseIndex
        // becomes invalid so beware not to use it anywhere or UB guaranteed
        m_wordNoCaseIndex->merge(*m_wordCaseIndex);

        // keep track of all the words
        m_wordCount = m_wordNoCaseIndex->size();

        // now put all values from m_wordNoCaseIndex into m_wordIdIndex
        for (auto &[proxyWord, wordId] : *m_wordNoCaseIndex) {
            m_wordIdIndex->try_emplace(wordId, proxyWord);
        }

        LOGT("Finish lazy init");
        // finally write created indexes into word index file...
#endif

        //
        // WordIdIndex
        //
        if (auto ccode = writeEntry(offsets.wordIdIndex, *m_wordIdIndex))
            return ccode;

        //
        // Proxy collator types WordCaseIndex, WordNoCaseIndex
        //
#ifdef KEEP_CASE_INDEX
        // write m_wordCaseIndex into word index file is
        // possible only without lazy init for indexes because
        // if we use index lazy init model by this point in code
        // m_wordCaseIndex will be already invalid because of
        // merge() method has been called to create m_wordNoCaseIndex
        // using same memory (see comments few lines above)
#ifndef INDEX_LAZY_INIT
        if (auto ccode = (writeEntry(offsets.wordCaseIndex, *m_wordCaseIndex)))
            return ccode;
#endif
#endif
        if (auto ccode =
                writeEntry(offsets.wordNoCaseIndex, *m_wordNoCaseIndex))
            return ccode;

        LOGT("Final header offsets", offsets);

        // Finally we can now write the header itself, everything should be
        // ready to go for a memory mapped re-hydration of this file when the
        // SearchBatch job is used
        if (auto ccode = m_stream->tryWrite(hdr)) return ccode;

        // Close the stream and get final stats
        if (auto ccode = finalize()) return ccode;

        LOGT("Successfully closed word DB in", time::now() - start, "of size",
             m_stats->physicalSize);

        deinit(true);

        return {};
    }
#endif
    //---------------------------------------------------------------------
    //	@details
    //		Helper finction to compress given chunk with document structure
    //		and write it into word index file
    //	@param[in]
    //		docId - id of document we`re committing
    //	@param[in]
    //		wordIds - vector containing  document structure. It can contain full
    //			document structure or just part of it (chunked saving)
    //	@param[in]
    //		docStructChunked - true if document structure is chunked and should
    //			be saved in a self describing chunks format, false otherwise
    //	@param[in]
    //		isFirstChunk - true means saving first chunk of chunked doc
    // structure
    //	@param[in]
    //		isLastChunk - true means saving last chunk of chunked doc structure
    //---------------------------------------------------------------------
    Error compressAndWriteChunk(DocId docId, const WordIdList &wordIds,
                                bool docStructChunked,
                                bool isFirstChunk = false,
                                bool isLastChunk = false,
                                size_t docElementsCount = 0) noexcept {
        memory::SmallArena<WordId> arena;
        memory::Data<WordId, memory::SmallAllocator<WordId>> compressedWordIds(
            arena);

        // Compress the word ID's
        ErrorOr<Opt<size_t>> originalSizeOr =
            compressIds(wordIds, compressedWordIds);
        if (!originalSizeOr) return originalSizeOr.ccode();

        Opt<size_t> originalSize = *originalSizeOr;
        ASSERT_MSG(!originalSize || compressedWordIds.size() != wordIds.size(),
                   "Compressed word ID's are the same size as the original "
                   "(ambiguous)");

        if (docStructChunked)  // saving chunksed doc structure
        {
            // if it is first chunk of the document add new entry into
            // m_docWordIdListIndex basically to store offset where this doc
            // structure begins and 0-marker showing chunked doc structure
            if (isFirstChunk) {
                // add to the index new entry as follows {offset, 0,
                // docElementsCount}
                // - offset - is an offset where current doc structure will
                // start
                // - 0 as size means this doc structure is saved in chunks
                // - docElementsCount as count means number of word ids in
                // entire uncompressed document structure actually this is
                // redundant and this information can be received as we process
                // each block one by one, so in future if we decide to get rid
                // of this it won`t be an issue to get full uncompressed size
                // (in number of elements or in bytes) out of each
                // chunkLeadingBlock (see below) but for now keep it here for
                // convenience
                (*m_docWordIdListIndex)[docId] = {
                    .offset = m_stream->offset() / sizeof(WordId),
                    .size = 0,
                    .count = _nc<uint32_t>(docElementsCount)};
            }

            // if compression was successfull but for some reason it results in
            // bigger size proceed without compression. In this case while
            // uncompressing we will definitely know if this particular chunk is
            // compressed or not just by checking its compressed and
            // uncompressed sizes compressedSize <  originalSize => compressed
            // compressedSize >= originalSize => uncompressed
            if (originalSize && compressedWordIds.size() < originalSize) {
                // save control block before chunk { compressedSize,
                // uncompressedSize } so on read we can restore each block one
                // by one as single-linked list
                std::vector<uint32_t> chunkLeadingBlock = {
                    _nc<uint32_t>(compressedWordIds.size() * sizeof(WordId)),
                    _nc<uint32_t>(wordIds.size() * sizeof(WordId))};

                if (auto ccode =
                        m_stream->tryWrite(memory::viewCast(chunkLeadingBlock)))
                    return ccode;

                // finally write compressed chunk itself
                if (auto ccode =
                        m_stream->tryWrite(memory::viewCast(compressedWordIds)))
                    return ccode;
            } else {
                // save control block before chunk { compressedSize,
                // uncompressedSize } so on read we can restore each block one
                // by one as single-linked list
                std::vector<uint32_t> chunkLeadingBlock = {
                    _nc<uint32_t>(wordIds.size() * sizeof(WordId)),
                    _nc<uint32_t>(wordIds.size() * sizeof(WordId))};

                if (auto ccode =
                        m_stream->tryWrite(memory::viewCast(chunkLeadingBlock)))
                    return ccode;

                // finally write uncompressed chunk itself
                if (auto ccode = m_stream->tryWrite(memory::viewCast(wordIds)))
                    return ccode;
            }

            // after last chunk is written add finish marker of {0, 0}
            // so on read we can find out it was last chunk of current doc
            if (isLastChunk) {
                std::vector<uint32_t> chunkTrailingBlock = {0, 0};

                if (auto ccode = m_stream->tryWrite(
                        memory::viewCast(chunkTrailingBlock)))
                    return ccode;
            }

            LOGT("Committed doc struct chunk");
        } else  // saving doc structure in single array
        {
            if (originalSize) {
                // We know its address now add it to the index, note since we
                // are compressing we also store its original size in the count
                // field, size stores its compressed size at the offset
                (*m_docWordIdListIndex)[docId] = {
                    .offset = m_stream->offset() / sizeof(WordId),
                    .size = _nc<uint32_t>(compressedWordIds.size()),
                    .count = _nc<uint32_t>(*originalSize)};

                // Place it onto the streams queue for processing
                if (auto ccode =
                        m_stream->tryWrite(memory::viewCast(compressedWordIds)))
                    return ccode;
            } else {
                // Proceed without compression (same size and count will signal
                // that the word ID's are not compressed)
                (*m_docWordIdListIndex)[docId] = {
                    .offset = m_stream->offset() / sizeof(WordId),
                    .size = _nc<uint32_t>(wordIds.size()),
                    .count = _nc<uint32_t>(wordIds.size())};

                // Place it onto the streams queue for processing
                if (auto ccode = m_stream->tryWrite(memory::viewCast(wordIds)))
                    return ccode;
            }
        }

        // Update our wordDocIdSetIndex, we won't have another chance
        for (auto wordId : wordIds) {
#ifdef USE_BUCKET_ARRAY
            (*m_wordDocIdSetIndex).put(wordId, docId);
#elif defined USE_SLIDING_WINDOW

            // add new IIEntry
            m_invertedIndexSegment.emplace_back(docId, wordId);

            // if current segment is full
            if (m_invertedIndexSegment.size() ==
                m_invertedIndexSegment.capacity()) {
                if (auto ccode = processIISegment()) return ccode;
            }
#else
            (*m_wordDocIdSetIndex)[wordId].insert(docId);
#endif
        }

        return {};
    }

    //---------------------------------------------------------------------
    // This is the new commit to be used with the new pipe instance task
    // The caller must have obtained the wordLock before calling this
    // function!
    //---------------------------------------------------------------------
    Error commit(const DocHash &hash, WordIdList &wordIds,
                 engine::store::VirtualBuffer &vbuf,
                 bool docStructChunked) noexcept {
        if ((docStructChunked && !vbuf.size()) || (!docStructChunked && !wordIds.size()))  {
            // Register the document hash even with no words so that
            // lookupDocId will find it during renderObject (e.g. images)
            addDocHashFirst(hash);
            ++m_docCount;
            return {};
        }

        // Allocate this document id
        auto docId = addDocHashFirst(hash);

        // If this documents is already there, done
        if (!docId) return {};

        auto start = time::now();

        // handle chunked doc structure
        if (docStructChunked) {
            // wordIds already has desired capacity so resize to capacity and
            // read into it
            wordIds.resize(wordIds.capacity());
            size_t wordIdsByteSize = wordIds.size() * sizeof(WordId);

            OutputData outData{_reCast<uint8_t *>(wordIds.data()),
                               wordIdsByteSize};

            bool firstChunk = true, lastChunk = false;
            size_t sizeRead = 0, totalRead = 0;
            size_t vbufSize =
                vbuf.size();  // full size in bytes of document structure
            size_t docElementsCount =
                vbuf.size() /
                sizeof(
                    WordId);  // number of elements in entire document structure

            while (totalRead < vbufSize) {
                // 1. read the chunk from virtual buffer
                auto res = vbuf.readData(totalRead, outData);

                // check if read was successfull
                if (res.hasCcode()) return res.ccode();

                sizeRead = res.value();
                totalRead += sizeRead;

                // if we read less than expected this is the last block thus
                // shrink vector
                if (sizeRead < wordIdsByteSize)
                    wordIds.resize(sizeRead / sizeof(WordId));

                if (totalRead == vbufSize) lastChunk = true;

                // 2. compress current chunk
                // 3. write compressed (or uncompressed) chunk into word index
                // file
                // 4. update wordDocIdSetIndex with contents of current chunk
                compressAndWriteChunk(docId, wordIds, docStructChunked,
                                      firstChunk, lastChunk, docElementsCount);

                firstChunk = false;

                // resize back to capacity just in case
                wordIds.resize(wordIds.capacity());
            }
        } else {  // handle doc structure fitted in one bucket
            compressAndWriteChunk(docId, wordIds, docStructChunked);
            LOGT("Committed doc with {,c} words in {}", wordIds.size(),
                 time::now() - start);
        }

        // keep track of number of committed documents
        ++m_docCount;

        // turn on this log message for now just to have the info about the
        // documents committed so far and the number of unique words to be able
        // to get info from the logs even in case when trace flag WordDb is
        // turned off. We can change it to LOGT
        LOGT(
            "Number of documents committed {}, number of unique words so far "
            "{}",
            m_docCount, m_uniqueWordCount);

        return {};
    }

    // Must call setKeepDocWordIds(true) prior to indexing for this API to
    // function Used only when classifying documents in a write DB
    WordIdList lookupDocWordIdList(DocId docId) const noexcept {
        ASSERTD_MSG(m_keepDocWordIds,
                    "Not configured to keep doc word ID's in memory");

        auto iter = m_docWordIds.find(docId);
        if (iter == m_docWordIds.end()) return {};

        return iter->second;
    }

    template <typename T>
    void lookupDocMetadataWordIds(DocId id, T &cnt) const noexcept {
        cnt.clear();
        if (auto iter = m_docMetadataWordIds->find(id);
            iter != m_docMetadataWordIds->end())
            _addTo(cnt, iter->second);
    }

    ErrorOr<Metadata> getDocMetadata(DocId docId) const noexcept {
        Metadata metadata;
        // @@@ if (auto ccode = metadata.load(*this, docId))
        // 	return ccode;
        return metadata;
    }

    WordId nextWordId() const noexcept { return m_nextWordId; }

    Error open(StreamPtr &&stream) noexcept {
        if (m_stream)
            return APERRT(Ec::AlreadyOpened, "Word DB already opened");

        // Need to start at an aligned position for memory mapped i/o at open
        if (auto ccode = stream->tryWriteAlign()) {
            m_stream.reset();
            return ccode;
        }

        m_stream = _mv(stream);
        LOGT("Successfully opened word DB", m_stream);

        // Get an ICU normalizer instance (used by contexts, but they have no
        // way to return an error if they can't get a normalizer for some
        // reason)
        auto normalizer = string::icu::getNormalizer();
        if (!normalizer)
            return APERRT(normalizer.ccode(),
                          "Unable to get normalizer instance");
        m_normalizer.emplace(_mv(*normalizer));

        m_wordStrings.emplace();

        // For the map/set types, we use the mono resource as they will never
        // free now if INDEX_LAZY_INIT defined we`ll release m_monoRes before
        // filling up m_lazyInitRes
#ifdef INDEX_LAZY_INIT
        m_wordCaseIndex.emplace(*m_wordStrings, &m_lazyInitRes);
        m_wordNoCaseIndex.emplace(*m_wordStrings, &m_lazyInitRes);
        m_wordIdIndex.emplace(&m_lazyInitRes);
#else
        m_wordCaseIndex.emplace(*m_wordStrings, &m_monoRes);
        m_wordNoCaseIndex.emplace(*m_wordStrings, &m_monoRes);
        m_wordIdIndex.emplace(&m_monoRes);
#endif

#ifdef USE_SLIDING_WINDOW
        m_invertedIndexSegment.reserve(
            m_iiEntriesCount);  // reserve memory upfront
#else
        m_wordDocIdSetIndex.emplace(&m_monoRes);
#endif

        m_docHashIndex.emplace(&m_monoRes);
        m_docIdIndex.emplace(&m_monoRes);
        m_docMetadataWordIds.emplace(&m_monoRes);
        m_docWordIdListIndex.emplace(&m_monoRes);

        m_docCount = 0;
        m_docWordCount = 0;
        m_wordCount = 0;
        m_uniqueWordCount = 0;

        m_nextWordId = FirstWordId;
        m_nextDocId = FirstDocId;
        m_stats.reset();
        return {};
    }

    Error open(const Url &url) noexcept {
        if (m_stream)
            return APERRT(Ec::AlreadyOpened, "Word DB already opened");

        // Open it
        ErrorOr<StreamPtr> stream = _call([&] {
            return stream::openBufferedStream(url, stream::Mode::WRITE);
        });
        if (!stream) return stream.ccode();

        return open(_mv(*stream));
    }

private:
    void deinit(bool graceful) noexcept {
        if (!m_stream) return;

        m_wordIdIndex.reset();
        m_wordNoCaseIndex.reset();
        m_wordCaseIndex.reset();

#ifdef INDEX_LAZY_INIT
        m_lazyInitRes.release();
#else
        m_wordCaseIndex.reset();

#ifndef USE_SLIDING_WINDOW
        m_wordDocIdSetIndex.reset();
#endif
        m_docHashIndex.reset();
        m_docIdIndex.reset();
        m_docMetadataWordIds.reset();
        m_wordStrings.reset();
        m_docWordIdListIndex.reset();

        m_monoRes.release();
#endif

        m_stream->close(graceful);
        m_stream.reset();

        // Leave stats around so they can be asked for
    }

    Error finalize() noexcept {
        // Forcibly update stats prior to closing the stream, as doc count and
        // physical size will be unavailable
        m_stats = stats(true);

        // If we're writing to disk that has write caching, the file may still
        // be empty until we close and flush. Since our API doesn't have a way
        // to force a flush, wait until after we've closed to get physical size.
        const auto physPath = m_stream->path();

        // If we're not writing to disk, update stats with stream size
        if (!physPath) {
            if (auto physSize = m_stream->tryGetSize())
                m_stats->physicalSize = *physSize;
        }

        // Finally close the stream
        if (auto ccode = m_stream->tryClose()) return ccode;

        // If we're writing to disk, update stats with file size
        if (physPath) {
            if (auto physSize = file::length(physPath))
                m_stats->physicalSize = *physSize;
        }

        return {};
    }

    ProxyWord addWordToWordPack(TextView word) noexcept {
        auto offset = m_wordStrings->size();
        _addTo(*m_wordStrings, word);
        if (m_wordAddCallback)
            m_wordAddCallback({.count = 1, .size = word.size()});
        return {offset, _nc<uint32_t>(word.size())};
    }

    // Compress ID's using FastPFor (NullOpt means not compressed)
    template <typename In, typename Out>
    ErrorOr<Opt<size_t>> compressIds(const In &ids,
                                     Out &compressed) const noexcept {
        // If compression has been disabled via config, bail
        if (!m_compress) return NullOpt;

        auto originalSize =
            compress::deflate<compress::Type::FASTPFOR>(ids, compressed);
        if (!originalSize) {
            // If we failed to compress for any reason other than compression is
            // not supported, bail
            if (originalSize.ccode() != Ec::NotSupported)
                return originalSize.ccode();
            else
                return NullOpt;
        }

        // If the count of compressed ID's is the same as the original, proceed
        // without compression Otherwise, we won't be able to tell when reading
        // the ID's whether they were compressed
        if (compressed.size() == ids.size()) return NullOpt;

        return *originalSize;
    }

private:
    // m_wordLock is used to arbitrate amongst incoming threads adding
    // words into the word structures, documents comitting, etc. However,
    // the m_lock shared is no longer used by the pipes. It is contained within
    // the global index pipe and is still defined here for compat with exising
    // code that tried to use a single lock for everything
    mutable async::MutexLock m_wordLock{};

    mutable async::SharedLock m_lock;

    // ICU normalizer for NFKC
    Opt<string::icu::Normalizer> m_normalizer;

    memory::MonotonicResource m_monoRes{
        SlabSize};  // this one for all indexes that we create on the fly
#ifdef INDEX_LAZY_INIT
    memory::MonotonicResource m_lazyInitRes{
        SlabSize};  // this is for wordCaseIndex and for indexes that
                    // can be created right before writing into word index file
                    // (m_wordIdIndex and m_wordNoCaseIndex)
#endif

    // List of strings for the words... contains both case sensitive and
    // case insensitive strings
    Opt<WordStrings<>> m_wordStrings;

    // For every word id, the pts into the string table
    Opt<PolyWordCaseIndex> m_wordCaseIndex;
    Opt<PolyWordNoCaseIndex> m_wordNoCaseIndex;

#ifdef USE_SLIDING_WINDOW
    //-----------------------------------------------------------------
    /// @details
    ///     Preallocated vector storing inverted index entries { wordId, docId }
    //-----------------------------------------------------------------
    IIEntriesVector m_invertedIndexSegment{};

    //-----------------------------------------------------------------
    /// @details
    ///     The number of inverted index entries we can put into
    ///		m_invertedIndexSegment before writing contents of segment
    ///		into file and move on to next segment
    //-----------------------------------------------------------------
    const size_t m_iiEntriesCount{1_gb / sizeof(IIEntry)};

    //-----------------------------------------------------------------
    /// @details
    ///		Buffer that will automatically create temp file on disk
    ///		as we write segments of inverted index into it. While committing the
    /// document 		we write segments into it. When closing word db file we
    /// read from it.
    //-----------------------------------------------------------------
    engine::store::VirtualBuffer m_segmentsFile{config::paths().cache};

    //-----------------------------------------------------------------
    /// @details
    ///		Control table which is used during segments merge step
    //-----------------------------------------------------------------
    SegmentsControlTable m_segmentsControlTable;

    //-----------------------------------------------------------------
    /// @details
    ///		The number of entries from each segment we can put into the buffer
    /// at once
    //-----------------------------------------------------------------
    size_t m_chunkEntries = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		The number of segments we`re processing
    //-----------------------------------------------------------------
    size_t m_segmentsCount = 0;

#else
    // All the documents containing a word. There is an an entry for
    // every word contained in the set of documents
    Opt<PolyWordDocIdSetIndex> m_wordDocIdSetIndex;
#endif

    // Maps the document hash to its integer document id
    Opt<PolyDocHashIndex> m_docHashIndex;

    // Maps the integer document id to its document hash
    Opt<PolyDocIdIndex> m_docIdIndex;

    // For every document, it's metadata word list
    Opt<PolyDocMetadataIndex> m_docMetadataWordIds;

    // For every document, its offset, size and count of it's list of words
    Opt<PolyDocWordIdListIndex> m_docWordIdListIndex;

    // For every word, its offset and size in the word string list
    Opt<PolyWordIdIndex> m_wordIdIndex;

    // stats members
    size_t m_docCount = 0;
    size_t m_docWordCount = 0;
    size_t m_wordCount = 0;
    size_t m_uniqueWordCount = 0;

    Atomic<WordId> m_nextWordId = FirstWordId;
    DocId m_nextDocId = FirstDocId;
    StreamPtr m_stream;
    Opt<Stats> m_stats;
    bool m_compress = true;
    std::map<DocId, WordIdList> m_docWordIds;
    bool m_keepDocWordIds = false;

    WordAddCallback m_wordAddCallback;
};

}  // namespace engine::index::db
