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

#include <engLib/eng.h>

namespace engine::store::filter::indexer {
//-------------------------------------------------------------------------
/// @details
///		Returns the current batch id
///	@returns
///		Error
//-------------------------------------------------------------------------
uint64_t IFilterGlobal::currentBatchId() const noexcept {
    return m_indexBatchId + m_wordDbRev;
}

//-------------------------------------------------------------------------
/// @details
///     Checks if the wordId is approaching its max wrapping point, or if the
///     total in memory element count exceeds some threshold, in either case the
///     queues will get flushed, the batchId will be incremented, and then the
///     wordDb will get re-opened (as it is named the batchId)
//-------------------------------------------------------------------------
bool IFilterGlobal::checkBatchThresholds() noexcept {
    if (m_db->nextWordId() > m_maxWordCount) {
        LOGT("Max index word count hit {,c} (max:{,c})", m_db->nextWordId(),
             m_maxWordCount);
        return true;
    }

    if (m_db->docCount() > m_maxItemCount) {
        LOGT("Max items per batch hit {,c} (max:{,c})", m_db->docCount(),
             m_maxItemCount);
        return true;
    }

    return false;
}

//-------------------------------------------------------------------------
/// @details
///		Returns the Url path for current batch
///	@returns
///		Error
//-------------------------------------------------------------------------
Url IFilterGlobal::wordDbPath() const noexcept {
    auto batchId = currentBatchId();
    auto path = util::Vars::expandRequired(
        m_indexOutput.fullpath().gen(), "BatchId", _tso(Format::HEX, batchId));

    return m_indexOutput.setPath(path);
}

//-------------------------------------------------------------------------
/// @details
///		Waits until the last database is actually written by the background
///     worker thread
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterGlobal::waitWordDbWriter() noexcept {
    // If we have no worker, done
    if (!m_wordDbWriter) return {};

    LOGT("Waiting for word db to finish writing");
    if (auto ccode = m_wordDbWriter->join()) {
        LOGT("Word db has an error in writing", ccode);
        return ccode;
    }

    LOGT("Word db has finished writing");
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Opends up the word database
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterGlobal::openWordDb() noexcept {
    // If we have reached our 256 limit we cannot proceed
    if (m_wordDbRev >= MaxWordDbRev)
        return MONERR(error, Ec::BatchExceeded,
                      "Index job processed maximum batches");

    // Check whether the previous word DB failed to write
    if (auto ccode = waitWordDbWriter()) return ccode;

    auto path = wordDbPath();
    LOGT("Opening word db {}", path);

    auto wordDbStream = stream::openBufferedStream(path, stream::Mode::WRITE);
    if (!wordDbStream)
        return MONERR(error, wordDbStream.ccode(),
                      "Failed to open word database stream", wordDbPath());

    m_db = std::make_unique<WordDbWrite>();
    if (auto ccode = m_db->open(_mv(*wordDbStream)))
        return MONERR(error, ccode, "Failed to open word database",
                      wordDbPath());

    if (m_indexCompress)
        LOGT("Compression has been enabled");
    else
        LOGT("Compression has been disabled");
    m_db->setCompress(m_indexCompress);

    // Notify a wordBatchId has been born
    MONITOR(infoFmt, R"({"wordDbName": "{}", "wordDbBatchId": "{}"})})",
            wordDbPath().fileName(), currentBatchId());

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Output the words that we found to the output file. This is
///		part of the closing of the database
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterGlobal::outputWords() noexcept {
    // Reserve an area on the stack for the word
    StackTextArena arena;
    StackText line{arena};

    // Get the current batch id
    auto batchId = currentBatchId();
    json::Value value;

    // For each available word
    for (auto &[addr, wordId] : m_db->wordCaseIndex()) {
        // Don't emit word records for symbols-- they're not searchable, and
        // they may be whitespace
        if (!index::db::isSearchable(wordId)) continue;

        // Get the word
        auto word = m_db->lookupWord(addr);

        // W*{"batchId": batchId, "word": "word"}
        line.clear();
        value["batchId"] = batchId;
        value["word"] = word;
        _tsbo(line, task::defFormatOptions(), 'W', value.stringify(false),
              '\n');

        if (auto ccode = endpoint->taskWriteText(line)) return ccode;
    }

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Closes and current word db ands writes it to disk. The actual
///     write process runs in the background, so it is not truly closed
///     until you call waitWordDbWrite method
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterGlobal::closeWordDb() noexcept {
    if (!m_db) return {};

    auto path = wordDbPath();
    LOGT("Closing word db {}", path);

    MONITOR(status, "Writing word index");

    // Wait for the previous word DB to finish writing
    if (auto ccode = waitWordDbWriter())
        return APERRT(ccode, "Failed to write previous word DB");

    MONITOR(status, "Saving word text");

    // Write the words to the output pipe if allowed to
    if (auto ccode = outputWords()) {
        MONERR(error, ccode, "Failed to write word list to output");
        return ccode;
    }

    // Write the word DB asynchronously
    auto task = async::work::submit(
        _location, "Write word DB", [wordDb = _mv(m_db)]() noexcept -> Error {
            LOG(ServiceIndexer, "Working on closing word db");

            // Finalize the word db this will write out all the required
            // components on our target service which may be remote on an
            // aggregator or local on a datafile
            if (auto ccode = wordDb->close()) {
                MONERR(error, ccode, "Failed to write word database");
                return ccode;
            }

            // Report word DB stats to monitor
            MONITOR(info, "wordDbStats", _tj(wordDb->stats()));

            LOG(ServiceIndexer, "Worker has closed word db");
            return {};
        });

    if (!task) return APERRT(task.ccode(), "Failed to spawn task");
    m_wordDbWriter = _mv(*task);

    MONITOR(status, "Processing documents");

    // From here on out, if we open another our revision will be unique
    m_wordDbRev++;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This function will check the thresholds and determines if it's
///		time to switch batches. If so, it gains an exclusive lock and
///		performs the switch
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterGlobal::checkSwitchToNextBatch() noexcept {
    const auto switchBatch = localfcn()->Error {
        // It's time - so go get an exclusive write lock on the database.
        // Although not specifically stated in the standard, a lot of articles
        // address the fact that if an outstanding exclusive lock is requested,
        // a shared lock will wait until the the exclusive is unlocked.
        // Otherwise, it would cause a situation called writer starvation
        auto guard = lock();

        // Now, check it again, someone else may have dumped it while we were
        // waiting for the exclusive lock
        if (!checkBatchThresholds()) {
            LOGT("Someone else switched the word db");
            return {};
        }

        // Yep, its time
        LOGT("Switch closing the current word db");
        if (auto ccode = closeWordDb()) return ccode;

        // Now, open another one
        LOGT("Switch opening the new word db");
        if (auto ccode = openWordDb()) return ccode;

        LOGT("Switch complete");
        return {};
    };

    // Do a quick check here
    if (!checkBatchThresholds()) return {};

    // Switch it
    auto ccode = switchBatch();
    return ccode;
}

//-----------------------------------------------------------------
/// @details
///		Return the word count of the current document
//-----------------------------------------------------------------
size_t IFilterInstance::wordCount() const noexcept {
    return m_fullDocWordsCount;
}

//-----------------------------------------------------------------
/// @details
///     Determine if we can continue to add words to the
///     document
//-----------------------------------------------------------------
bool IFilterInstance::capped() const noexcept {
    static_assert(DocWordCountSoftCap < DocWordCountHardCap);
    static_assert(DocWordCountHardCap <= MaxValue<uint32_t>);

    return wordCount() >= DocWordCountSoftCap;
}

//-----------------------------------------------------------------
/// @details
///     Whether we can still append anything
//-----------------------------------------------------------------
bool IFilterInstance::hardCapped() const noexcept {
    static_assert(DocWordCountHardCap > DocWordCountSoftCap);
    static_assert(DocWordCountHardCap <= MaxValue<uint32_t>);

    return wordCount() >= DocWordCountHardCap;
}

//-----------------------------------------------------------------
/// @details
///		Determine if this document is cancelled due to us maxing
///		out the word count
//-----------------------------------------------------------------
bool IFilterInstance::cancelled() const noexcept { return capped(); }

//-----------------------------------------------------------------
/// @details
///		Add single word and get word ID
///	@param[in] words
///		Words to add
//-----------------------------------------------------------------
Opt<WordId> IFilterInstance::addWord(TextView word) noexcept {
    return addWordImpl(word);
}

//-----------------------------------------------------------------
/// @details
///		Add a set of word mappings to the wordDb
///	@param[in] words
///		Words to add
//-----------------------------------------------------------------
Error IFilterInstance::addWords(const WordVector &words) noexcept {
    size_t count = 0;
    auto lock = global.m_db->wordLock();

    // Add the words
    for (auto &word : words) {
        // Chain the allocator
        addWordImpl(word, word.get_allocator());
        count++;
    }

    // Update the word count
    MONITOR(addWords, count);
    return {};
}

//-----------------------------------------------------------------
/// @details
///		The finalize function is called when the end of the
///		parsing stream is reached
//-----------------------------------------------------------------
Error IFilterInstance::finalize() noexcept {
    ASSERT(currentEntry->componentId());

    // Now, lock the db - we are adding words (via the metadata save)
    // and comitting the document
    auto lock = global.m_db->wordLock();

    // flush leftovers into buffer if and only if
    // doc structure is cunked already
    if (m_docStructChunked) {
        if (auto ccode = writeIdsToBuffer(true)) return ccode;
    }

    // Commit this document
    return global.m_db->commit(currentEntry->componentId.hash(), m_wordIds,
                               m_buffer, m_docStructChunked);
}

//-----------------------------------------------------------------
/// @details
///		Add a reserved word to the wordDb
///	@param[in] word
///		Word to add
//-----------------------------------------------------------------
Error IFilterInstance::addReservedWordId(
    index::db::ReservedWordId wordId) noexcept {
    // Allow reserved words to be written even if we're soft-capped
    if (hardCapped()) return {};

    // Save the word and return it
    addWordId(EnumIndex(wordId));
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Helper function to add word id into doc structure bucket.
///     Checks if bucket is filled up to max and writes it to
///     temp file on disk if so.
///	@param[in] wordId
///		WordId to add
//-----------------------------------------------------------------
Error IFilterInstance::addWordId(WordId wordId) noexcept {
    // If current vector for doc structure is filled up
    // write its contents into temp file, clear it and
    // only then add new word id into it
#ifdef CHUNKED_DOC_STRUCT
    if (m_wordIds.size() == m_wordIds.capacity()) {
        LOGT("Document structure chunk limit reached. Writing it to disk");

        if (auto ccode = writeIdsToBuffer(true)) return ccode;
    }
#endif

    // push the new word id
    m_wordIds.push_back(wordId);

    // increase counter for full document words keeping track of all
    // the words in current document
    ++m_fullDocWordsCount;

    return {};
}

//-----------------------------------------------------------------
/// @details
///		Helper function to write current chunk of doc structure
///     into buffer to stream them into .overflow file on disk.
///	@param[in] clearDocIds
///		If true then also clear current chunk of doc ids after writing
///     Default value is false
//-----------------------------------------------------------------
Error IFilterInstance::writeIdsToBuffer(bool clearDocIds) noexcept {
    if (m_wordIds.empty()) return {};

    // Create data view into current doc structure vector
    auto data = InputData{_reCast<const uint8_t *>(m_wordIds.data()),
                          m_wordIds.size() * sizeof(WordId)};

    // Write it to the overflow buffer
    if (auto ccode = m_buffer.writeData(data)) return ccode;

    // now clear contents of m_wordIds but keep its capacity and allocated
    // memory
    if (clearDocIds) m_wordIds.clear();

    // and set flag for chunked doc structure
    m_docStructChunked = true;

    return {};
}

}  // namespace engine::store::filter::indexer
