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

//-----------------------------------------------------------------------------
//
//	The indexer filter essentially encapsulates the functionality of
//	the wordDb
//
//	Source Mode:
//		Currently, this is a target mode only filter. However, source mode
//		can be added to support things like re-classification, etc. This
//		will be accomplished by intercepting the renderObject function
//		which will open the database with the given batchId/componentId
//		specified in the entry object passed and enumerate all the words
//		within. This will probably collect the words and put them into
//		a Utf16 buffer to send to the writeText channel. This will allow
//		re-classification.
//
//	Target Mode:
//		The filter implements the writeWord* interface which receives arrays
//		of words to be indexed. This is usually sent by the parser filter,
//		which converts incoming tag data buffers into words streams.
//
//		Global:
//			The global pipe contains a shared instance of the index database
//			writer. The instances must arbitrate amongst themselves to
//			ensure that they don't interfere with each other. This is
//			accomplished by mutex locks during critical thing in the documents
//			processing.
//
//			The global process monitors the activity going on within the
//			instances, specifically, when the shared lock is released indicating
//			that it's current document is completed. When an instance releases
//			its shared lock, the wordDb is checked to determine if it is time
//			to roll to a new batch. If the thresholds are reached, an exclusive
//			lock is obtained, which ensures that all instances are no longer
//			processing a document, the wordDb is closed and a new one created to
//			handling more incoming documents.
//
//		Instance:
//			When an open function is called, we obtain a shared lock
//			on the currently open database. This ensures that while the document
//			is being processed, the database will not be switched due to
// capacity 			limits.
//
//			As text enters via the writeText method, it is sent to the wordDb
//			addWord function, a wordId is assigned and added to the document
// word 			list.
//
//			Once the closing function is called, the document is committed
//			into the wordDb index. Once this is completed, the shared lock is
//			released which allow the underlying wordDb to be switched by the
// global 			process if it has exceeded its threshholds
//
//			It is important that both the addWords and commits, which modify the
//			structures within the wordDb are protected via the wordLock mutex.
//			Otherwise the in memory structures will be corrupted if multiple
//			instances are updating at the same time.
//
//  NOTE:
//		There are a couple of possible optimizations that can be done
//		here
//
//		1. Right now, we are driving the open of a new database on switch
//		in the check change process after we close a database. We should
//		probably drive the opening of the next database off of sharedLock()
//		because at that point, we know we actually need another database.
//
//		2. The sharedLock is called when the object is opened (on the
//		open filter call). We can probably delay calling shared lock
//		until we get the first text ariving from the writeText interface.
//		This will allow the exclusive lock much more time and availability
//		to flush the previous database. As it stands now, the shared lock
//		is held during the processing of the document by the parser (tika)
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store::filter::indexer {
using namespace engine::index;

//-------------------------------------------------------------------------
// Include our dependencies
//-------------------------------------------------------------------------
class IFilterGlobal;
class IFilterInstance;

//-----------------------------------------------------------------
// Define our caps
//-----------------------------------------------------------------
_const size_t ReservedDocWordCount = 1;
_const size_t DocWordCountHardCap = MaxValue<uint32_t>;
_const size_t DocWordCountSoftCap = DocWordCountHardCap - ReservedDocWordCount;

//-------------------------------------------------------------------------
/// @details
///		Declare our factory info
//-------------------------------------------------------------------------
_const auto Type = "indexer"_itv;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceIndexer;

//-------------------------------------------------------------------------
/// @details
///		Define the common class for this filter
//-------------------------------------------------------------------------
class IFilterGlobal : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;

    _const uint32_t MaxWordDbRev = 256;

    //-----------------------------------------------------------------
    ///	@details
    ///		Allow the filter instance to see our private data. We can
    ///		either make it public, or limit the scope to IFilterInstance
    //-----------------------------------------------------------------
    friend IFilterInstance;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterGlobal, Parent>(Type);

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginFilterGlobal() noexcept override;
    virtual async::SharedLock::SharedGuard sharedLock() const noexcept;
    virtual async::SharedLock::UniqueGuard lock() const noexcept;
    virtual Error endFilterGlobal() noexcept override;

private:
    //-----------------------------------------------------------------
    // Private API - common
    //-----------------------------------------------------------------

    //-----------------------------------------------------------------
    /// @details
    ///     The database lock used when adding documents, switching
    ///		word dbs, etc
    //-----------------------------------------------------------------
    mutable async::SharedLock m_dbLock;

    //-----------------------------------------------------------------
    // Private API - target mode
    //-----------------------------------------------------------------
    uint64_t currentBatchId() const noexcept;
    bool checkBatchThresholds() noexcept;
    Url wordDbPath() const noexcept;
    Error waitWordDbWriter() noexcept;
    Error openWordDb() noexcept;
    Error outputWords() noexcept;
    Error closeWordDb() noexcept;
    Error checkSwitchToNextBatch() noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///     Declare our interface into the word db
    //-----------------------------------------------------------------
    UniquePtr<WordDbWrite> m_db;

    //-----------------------------------------------------------------
    /// @details
    ///     Is the index compressed?
    //-----------------------------------------------------------------
    bool m_indexCompress = false;

    //-----------------------------------------------------------------
    /// @details
    ///     For write mode, the url to the word db path
    //-----------------------------------------------------------------
    Url m_indexOutput;

    //-----------------------------------------------------------------
    /// @details
    ///     The base batch id to assign
    //-----------------------------------------------------------------
    uint64_t m_indexBatchId = 0;

    //-----------------------------------------------------------------
    /// @details
    ///     Our current revision to the word db, incremented each time
    ///		we hit our resource limits, each entry copies this value,
    ///		and it is added to the configurations batchId and is
    ///		recorded along with the output result
    //-----------------------------------------------------------------
    uint32_t m_wordDbRev = 0;

    //-----------------------------------------------------------------
    /// @details
    ///     Maximum number of words that can be contained in a single
    ///     word db
    //-----------------------------------------------------------------
    uint64_t m_maxWordCount = 250000000;

    //-----------------------------------------------------------------
    /// @details
    ///     Maximum number of documents that can be contained in
    ///		a single word db
    //-----------------------------------------------------------------
    uint64_t m_maxItemCount = 300000;

    //-----------------------------------------------------------------
    /// @details
    ///		Task to write the word DB asynchronously
    //-----------------------------------------------------------------
    async::work::Item m_wordDbWriter;

    //-----------------------------------------------------------------
    // Private API - source mode
    //-----------------------------------------------------------------
    ErrorOr<CRef<WordDbRead>> getWordBatch(uint64_t batchId) noexcept;
    Error updateCurrentWordDb(uint64_t batchId) noexcept;
    void releaseWordDb() noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///     For read mode, mapping of batchIds to resource paths
    //-----------------------------------------------------------------
    std::map<uint64_t, Url> m_batches;

    //-----------------------------------------------------------------
    /// @details
    ///     Open word db for reading
    //-----------------------------------------------------------------
    WordDbReadPtr m_currentWordDb = nullptr;

    //-----------------------------------------------------------------
    /// @details
    ///     Open word db id
    //-----------------------------------------------------------------
    uint64_t m_currentWordDbId = 0;

    //-----------------------------------------------------------------
    /// @details
    ///     WordDb sync primitives used when switching between word dbs
    //-----------------------------------------------------------------
    std::mutex m_wordDbLock;

    ap::async::Condition m_wordDbCondition;

    //-----------------------------------------------------------------
    /// @details
    ///     Number of threads using the currently open word db
    //-----------------------------------------------------------------
    size_t m_currentWordDbReaders = 0;
};

//-------------------------------------------------------------------------
/// @details
///		Define the instance class for this filter
//-------------------------------------------------------------------------
class IFilterInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;

    //---------------------------------------------------------------------
    // Define the encapsulate tokenizer. This will accept text, convert
    // it to words (tokens) and call the parents writeWords method
    //---------------------------------------------------------------------
    class Tokenize {
        //-----------------------------------------------------------------
        ///	@details
        ///		The trace flag for this component
        //-----------------------------------------------------------------
        _const auto LogLevel = Level;

        //-----------------------------------------------------------------
        ///	@details
        ///		Text buffer split on white space boundary
        //-----------------------------------------------------------------
        _const size_t UnicodeBufferChars = 64_kb;

    public:
        //-----------------------------------------------------------------
        // Constructor requires the this ptr of who the containing
        // IFilterInstane is so we can call addWords on it
        //-----------------------------------------------------------------
        Tokenize(IFilterInstance &owner) : m_parent(owner) {}

        //-----------------------------------------------------------------
        // Publics
        //-----------------------------------------------------------------
        virtual Error open(Entry &object) noexcept;
        virtual Error writeText(const Utf16View &text) noexcept;
        virtual Error closing() noexcept;

    private:
        //-----------------------------------------------------------------
        // Privates
        //-----------------------------------------------------------------
        size_t capacity() const noexcept;
        Error parseText(Utf16View text) noexcept;
        Error processText(const Utf16View &text) noexcept;
        Error flush() noexcept;

    private:
        //-----------------------------------------------------------------
        /// @details
        ///		Reference to our containing IFilterInstance
        //-----------------------------------------------------------------
        IFilterInstance &m_parent;

        //-----------------------------------------------------------------
        /// @details
        ///		How many unicode code points do we have in the buffer
        //-----------------------------------------------------------------
        size_t m_unicodeBufferLength = 0;

        //-----------------------------------------------------------------
        /// @details
        ///		Holds the unicode code points we are buffering up
        //-----------------------------------------------------------------
        Utf16Chr m_unicodeBuffer[UnicodeBufferChars];

        //-----------------------------------------------------------------
        ///	@details
        ///		Characters we have extracted
        //-----------------------------------------------------------------
        size_t m_charsExtracted = {};

        //-----------------------------------------------------------------
        ///	@details
        ///		Characters we have parsed
        //-----------------------------------------------------------------
        size_t m_charsParsed = {};

        //-----------------------------------------------------------------
        ///	@details
        ///		Pending high surrogate value
        //-----------------------------------------------------------------
        Utf16Chr m_highSurrogate = 0;
    };

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterInstance, Parent>(Type);

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IFilterInstance(const FactoryArgs &args) noexcept
        : Parent(args),
          global((static_cast<IFilterGlobal &>(*args.global))),
          m_tokenizer(*this) {};
    virtual ~IFilterInstance() {};

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginFilterInstance() noexcept override;
    virtual Error renderObject(ServicePipe &target,
                               Entry &object) noexcept override;
    virtual Error open(Entry &object) noexcept override;
    virtual Error writeText(const Utf16View &text) noexcept override;
    virtual Error closing() noexcept override;
    virtual Error endFilterInstance() noexcept override;

private:
    //-----------------------------------------------------------------
    // Allow our tokenizer access
    //-----------------------------------------------------------------
    friend class Tokenize;  // Grant access to Tokenize

    //-----------------------------------------------------------------
    // Private API
    //-----------------------------------------------------------------
    size_t wordCount() const noexcept;
    bool hardCapped() const noexcept;
    bool cancelled() const noexcept;
    bool capped() const noexcept;
    Opt<WordId> addWord(TextView word) noexcept;
    Error addWords(const WordVector &words) noexcept;
    Error addReservedWordId(index::db::ReservedWordId wordId) noexcept;
    Error addWordId(WordId wordId) noexcept;
    Error writeIdsToBuffer(bool clearDocIds = false) noexcept;
    Error finalize() noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		This is the actual implementation of adding a word. We
    ///		use this so we can get the appropriate allocator. Note
    ///     you MUST have the word lock at this point!!!
    ///	@param[in] word
    ///		Word to add
    ///	@param[in] alloc
    ///		Optional allocator
    //-----------------------------------------------------------------
    template <typename AllocT = std::allocator<Utf8Chr>>
    Opt<WordId> addWordImpl(TextView word, const AllocT &alloc = {}) noexcept {
        // If we've reached the maximum number of words per document, fail
        // silently
        if (capped()) return {};

        // Determine if the word is a single-character whitespace token
        const auto isSpace = index::db::isSpace(word);

        // If the new word is whitespace, and the last word ID is also
        // whitespace, replace the last word ID with the new word This covers
        // the case of " \n", i.e. HWS followed by VWS, which will be tokenized
        // as two words
        if (isSpace && !m_wordIds.empty() &&
            index::db::isSpace(m_wordIds.back())) {
            LOG(Words, "Replacing consecutive whitespace at word",
                m_wordIds.size());
            // Replace the final word with this one
            m_wordIds.pop_back();
        }

        // Add the word
        WordId wordId = global.m_db->addWord(word);
        LOG(Words, "Word {}: '{}' ({})", wordCount(), word, wordId);

        // Add the ID of the added word to our doc word ID's
        addWordId(wordId);
        return wordId;
    }

private:
    //-----------------------------------------------------------------
    // Reference to the bound pipe
    //-----------------------------------------------------------------
    IFilterGlobal &global;

    //-----------------------------------------------------------------
    // Encapsulated tokenizer to convert text to words
    //-----------------------------------------------------------------
    Tokenize m_tokenizer;

    //-----------------------------------------------------------------
    /// @details
    ///     The documents word ids
    //-----------------------------------------------------------------
    WordIdList m_wordIds{};

    //-----------------------------------------------------------------
    /// @details
    ///     The number of words we can put into fixed-size chunk of 128 MB
    ///		if the document has more words than m_docWordsCount write
    ///		contents of this chunk into temp file on disk and start over
    //-----------------------------------------------------------------
    const size_t m_docWordsCount{128_mb / sizeof(WordId)};

    //-----------------------------------------------------------------
    /// @details
    ///     Holds the total number of words in current document
    //-----------------------------------------------------------------
    size_t m_fullDocWordsCount{};

    //-----------------------------------------------------------------
    /// @details
    ///     True if doc structure is chunked to omit fully keeping it in memory
    ///		False otherwise. Default is false
    //-----------------------------------------------------------------
    bool m_docStructChunked{false};

    //-----------------------------------------------------------------
    /// @details
    ///		Buffer that will automatically create temp file on disk
    ///		as we write doc structure into it. While parsing the document
    ///		we write chunks into it. When committing the doc we read from it.
    //-----------------------------------------------------------------
    VirtualBuffer m_buffer{config::paths().cache};

    //-----------------------------------------------------------------
    /// @details
    ///     The received metadata for the document
    //-----------------------------------------------------------------
    json::Value m_metadata{};

    //-----------------------------------------------------------------
    /// @details
    ///     The temporary shared lock we have open while we are
    ///		indexing a document
    //-----------------------------------------------------------------
    mutable async::SharedLock::SharedGuard m_sharedLock{};
};

}  // namespace engine::store::filter::indexer
