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
//-------------------------------------------------------------------------
///	@details
///		Stats for a word store
//-------------------------------------------------------------------------
struct Stats {
    Count docCount;
    Count docWords;
    Count uniqueWords;
    Count totalWords;
    Size stringsSize;
    Size physicalSize;

    bool operator==(const Stats& stats) const noexcept {
        return docCount == stats.docCount && docWords == stats.docWords &&
               uniqueWords == stats.uniqueWords &&
               stringsSize == stats.stringsSize;
    }

    bool operator!=(const Stats& stats) const noexcept {
        return !(operator==(stats));
    }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        _tsb(buff, "  Documents      : ", docCount, "\n",
             "  Document words : ", docWords, "\n",
             "  Unique words   : ", uniqueWords, "\n",
             "  Total words    : ", totalWords, "\n",
             "  Strings size   : ", stringsSize, "\n",
             "  Physical size  : ", physicalSize, "\n");
    }

    auto __toJson(json::Value& val) const noexcept {
        val["docCount"] = _cast<int64_t>(docCount);
        val["docWords"] = _cast<int64_t>(docWords);
        val["uniqueWords"] = _cast<int64_t>(uniqueWords);
        val["totalWords"] = _cast<int64_t>(totalWords);
        val["stringsSize"] = _ts(stringsSize);
        val["physicalSize"] = _ts(physicalSize);
    }
};

//-------------------------------------------------------------------------
///	@details
///		First 129 ids are reserved for single character words (symbols) and
///		formatting codes
//-------------------------------------------------------------------------
_const WordId FirstWordId = 129;

//-------------------------------------------------------------------------
///	@details
///		Reserve the last 10 valid word ID's for custom semantics (e.g.
///		metadata delimiters)
//-------------------------------------------------------------------------
_const size_t ReservedWordIdCount = 10;

//-------------------------------------------------------------------------
///	@details
///		Determine the maximum word id we can allocate
//-------------------------------------------------------------------------
_const WordId MaxWordId = MaxValue<WordId> - ReservedWordIdCount;

//-------------------------------------------------------------------------
///	@details
///		Define the first word reserved word id. This is where
///		metadata starts
//-------------------------------------------------------------------------
_const WordId FirstReservedWordId = MaxWordId + 1;

//-------------------------------------------------------------------------
///	@details
///		Determines if the word is in the range of a reserved word
///	@param[in]	wordId
///		The word id to check
//-------------------------------------------------------------------------
inline constexpr bool isReservedWordId(WordId wordId) noexcept {
    return wordId >= FirstReservedWordId;
}

//-------------------------------------------------------------------------
///	@details
///		Determines if the word is in the symbolic word id values
///	@param[in]	wordId
///		The word id to check
//-------------------------------------------------------------------------
inline constexpr bool isSymbol(WordId wordId) noexcept {
    return wordId > 0 && wordId < FirstWordId;
}

//-------------------------------------------------------------------------
///	@details
///	    Determines if the word is searchable from app side
///	@param[in]  wordId
///     The word id to check
//-------------------------------------------------------------------------
inline constexpr bool isSearchable(WordId wordId) noexcept {
    return (wordId >= FirstWordId ||             // words we assigned ids to
            (wordId >= '0' && wordId <= '9') ||  // digits 0-9
            (wordId >= 'A' && wordId <= 'Z') ||  // capital letters A-Z
            (wordId >= 'a' && wordId <= 'z'))    // letters a-z
        ;
}

//-------------------------------------------------------------------------
///	@details
///		Determines if the word is either a word or a symbol that's
///		neither an ASCII symbol nor a space
///	@param[in]	wordId
///		The word id to check
//-------------------------------------------------------------------------
inline constexpr bool isWord(WordId wordId) noexcept {
    if (isSymbol(wordId))
        return !string::isSpace(wordId) && !string::isSymbol(wordId);
    return true;
}

//-------------------------------------------------------------------------
///	@details
///		Determines if the word is in the valid range of actual word ids
///	@param[in]	wordId
///		The word id to check
//-------------------------------------------------------------------------
inline constexpr bool isValidWordId(WordId wordId) noexcept {
    if (!wordId) return false;
    if (isReservedWordId(wordId)) return false;
    return true;
}

//-------------------------------------------------------------------------
///	@details
///		Parse symbol into it's word id equivalent
///	@param[in]	word
///		The word id to check
//-------------------------------------------------------------------------
inline WordId parseSymbol(TextView word) noexcept {
    // It must be exactly 1 bytes
    if (word.size() == 1) {
        // Convert that byte to a word id
        auto wordId = _cast<WordId>(word[0]);

        // See if it is a symbol
        if (isSymbol(wordId)) return wordId;
    }
    return 0;
}

//-------------------------------------------------------------------------
///	@details
///		Determines if the text word is a symbol. If it is length
///		of 1, it is
///	@param[in]	word
///		The word id to check
//-------------------------------------------------------------------------
inline bool isSymbol(TextView word) noexcept { return parseSymbol(word) != 0; }

//-------------------------------------------------------------------------
///	@details
///		Determines if the text word is a space
///	@param[in]	word
///		The word id to check
//-------------------------------------------------------------------------
inline bool isSpace(TextView word) noexcept {
    if (auto wordId = parseSymbol(word)) return string::isSpace(wordId);
    return false;
}

//-------------------------------------------------------------------------
///	@details
///		Determines if the text word is a space
///	@param[in]	wordId
///		The word id to check
//-------------------------------------------------------------------------
inline constexpr bool isSpace(WordId wordId) noexcept {
    return isSymbol(wordId) && string::isSpace(wordId);
}

//-------------------------------------------------------------------------
///	@details
///		Normalizes a symbol into ASCII space or NL
///	@param[in]	wordId
///		The word id to normalize
//-------------------------------------------------------------------------
inline constexpr WordId normalizeSymbol(WordId wordId) noexcept {
    if (isSymbol(wordId)) {
        if (string::isHorizontalSpace(_cast<char>(wordId)))
            return _cast<WordId>(' ');
        else if (string::isVerticalSpace(_cast<char>(wordId)))
            return _cast<WordId>('\n');
    }
    return wordId;
}

//-------------------------------------------------------------------------
///	@details
///		Normalizes a symbol into ASCII space or NL
///	@param[in]	word
///		The word id to check
//-------------------------------------------------------------------------
inline WordId normalizeSymbol(TextView word) noexcept {
    if (auto symbolicWordId = parseSymbol(word))
        return normalizeSymbol(symbolicWordId);
    return 0;
}

//-------------------------------------------------------------------------
///	@details
///		Enumeration of the reserved words at the end of the range
//-------------------------------------------------------------------------
enum class ReservedWordId : WordId {
    _begin = FirstReservedWordId,

    MetadataBlockStart = _begin,
    MetadataKeyEnd,
    MetadataValueEnd,

    _end
};

//-------------------------------------------------------------------------
///	@details
///		Render a symbol into a Text string
///	@param[in]	wordId
///		The word id to render
//-------------------------------------------------------------------------
inline Text renderSymbol(WordId wordId) {
    if (isSymbol(wordId)) return Text{_reCast<const char*>(&wordId), 1};
    return {};
}

//-------------------------------------------------------------------------
///	@details
///		Render a reserved id into text
///	@param[in] wordId
//-------------------------------------------------------------------------
constexpr TextView renderReservedWordId(ReservedWordId wordId) noexcept {
    switch (wordId) {
        case ReservedWordId::MetadataKeyEnd:
            return "="_tv;

        default:
            return "\n"_tv;
    }
}

//-------------------------------------------------------------------------
///	@details
///		Render a reserved id into text
///	@param[in] wordId
//-------------------------------------------------------------------------
constexpr TextView renderReservedWordId(WordId wordId) noexcept {
    if (isReservedWordId(wordId))
        return renderReservedWordId(_cast<ReservedWordId>(wordId));
    return {};
}

//-------------------------------------------------------------------------
///	@details
///		Define the starting document id. No special considerations for
///		the first docId, other then the fact that a docId of 0 is invalid
//-------------------------------------------------------------------------
_const DocId FirstDocId = 1;

//-------------------------------------------------------------------------
///	@details
///		Reserved number of ids at the end of a document to make sure
///		we have enough room to write the metadata bonudary
//-------------------------------------------------------------------------
_const size_t ReservedDocWordCount = 1024;

//-------------------------------------------------------------------------
///	@details
///		Hard-cap the number of document words at Max - 1
//-------------------------------------------------------------------------
_const size_t DocWordCountHardCap = MaxValue<uint32_t>;

//-------------------------------------------------------------------------
///	@details
///		Soft-cap the number of document words at hard cap - 1024 so
///		that we have room to write the metadata
//-------------------------------------------------------------------------
_const size_t DocWordCountSoftCap = DocWordCountHardCap - ReservedDocWordCount;

//-------------------------------------------------------------------------
///	@details
///		Doc context is a quick ref to the doc id and its word id list
///		container
//-------------------------------------------------------------------------
class DocCtx {
public:
    //-------------------------------------------------------------
    // Constructor/destructors
    //-------------------------------------------------------------
    DocCtx(DocId id) noexcept : m_id(id) {}
    DocCtx() = default;
    ~DocCtx() = default;
    DocCtx(const DocCtx&) = default;
    DocCtx(DocCtx&&) = default;

    //-------------------------------------------------------------
    ///	@details
    ///		Gets the component id of this document
    //-------------------------------------------------------------
    auto id() const noexcept { return m_id; }

    //-------------------------------------------------------------
    ///	@details
    ///		Gets the component id of this document
    //-------------------------------------------------------------
    WordIdListView wordIds() const noexcept { return m_wordIds; }

    auto wordCount() const noexcept { return m_wordIds.size(); }

    // Whether we can still append document words
    bool capped() const noexcept {
        static_assert(DocWordCountSoftCap < DocWordCountHardCap);
        static_assert(DocWordCountHardCap <= MaxValue<uint32_t>);

        return wordCount() >= DocWordCountSoftCap;
    }

    // Useful when writing to iStream
    operator InputData() const noexcept {
        return {_reCast<const uint8_t*>(m_wordIds.data()),
                m_wordIds.size() * sizeof(WordId)};
    }

    // Extract the metadata portion out
    WordIdListView metadataIds() const noexcept {
        if (m_wordIds.empty() || !m_metadataOffset) return {};
        return {&m_wordIds[*m_metadataOffset],
                m_wordIds.size() - *m_metadataOffset};
    }

    void setMetadataOffset() noexcept {
        ASSERT(!m_metadataOffset);
        m_metadataOffset = wordCount();
    }

    auto getMetadataOffset() const noexcept { return m_metadataOffset; }

    Opt<WordId> addReservedWordId(ReservedWordId wordId) noexcept {
        // Allow reserved words to be written even if we're soft-capped
        if (hardCapped()) return {};

        m_wordIds.push_back(EnumIndex(wordId));
        return EnumIndex(wordId);
    }

protected:
    // Whether we can still append anything
    bool hardCapped() const noexcept {
        static_assert(DocWordCountHardCap > DocWordCountSoftCap);
        static_assert(DocWordCountHardCap <= MaxValue<uint32_t>);

        return wordCount() >= DocWordCountHardCap;
    }

protected:
    DocId m_id = {};
    Opt<size_t> m_metadataOffset;
    WordIdList m_wordIds;
};

// Strings are a flat big mapped chunk of memory wrapped in a vector
template <typename AllocT = std::allocator<char>>
using WordStrings = std::vector<char, AllocT>;

// WordIds are like strings except they are word ids
template <typename AllocT = std::allocator<WordId>>
using WordIds = std::vector<WordId, AllocT>;

// DocIds are like strings except they are doc ids
template <typename AllocT = std::allocator<DocId>>
using DocIds = std::vector<DocId, AllocT>;
#pragma pack(push, 1)

// A general proxy word address indicating an offset/size to denote a
// collection of information. We specifically pack 1 here to save ~4 bytes of
// padding, and we accept the performance hit on un-aligned access,
// this is done to save memory both on disk and in ram
struct ProxyWord {
    using PodType = std::true_type;

    uint64_t offset = {};
    uint32_t size = {};

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << offset << ":" << size;
    }
};

// A general proxy address to a series of ids, indicating an offset/size/count
// to denote a collection of information. We specifically pack 1 here to save ~8
// bytes of padding, and we accept the performance hit on un-aligned access,
// this is done to save memory both on disk and in ram
struct ProxyIds {
    using PodType = std::true_type;

    uint64_t offset = {};
    uint32_t size = {};
    uint32_t count = {};

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << offset << ":" << size;
    }
};
#pragma pack(pop)

using ProxyWordIdList = ProxyIds;
using ProxyDocIdSet = ProxyIds;

static_assert(traits::IsPodV<ProxyIds>);
static_assert(traits::IsPodV<ProxyWord>);
static_assert(std::is_trivially_copy_assignable_v<ProxyIds>);
static_assert(std::is_trivially_copy_assignable_v<ProxyWord>);

// This collator sorts the string addresses when resident in memory, it
// holds a ref to the strings to expand the string addresses on demand during
// sorting/searching, however on disk it will remain logically sorted but
// since we don't use ptrs we'll be able to instantly re-hydrate the index
// on load time
template <typename CollatorT, typename ViewCollatorT,
          typename AllocT = std::allocator<char>>
struct ProxyWordCollator : public ChildOf<WordStrings<AllocT>> {
    using Parent = ChildOf<WordStrings<AllocT>>;
    using ParentType = typename Parent::ParentType;
    using Parent::parent;
    using CollatorType = CollatorT;
    using ViewCollatorType = ViewCollatorT;

    using is_transparent = std::true_type;

    string::StrView<char, ViewCollatorType> load(
        const ProxyWord& addr) const noexcept {
        ASSERT_MSG(parent().size() >= addr.offset + addr.size,
                   "Invalid string offset", addr, parent().size());
        return {&parent()[addr.offset], addr.size};
    }

    template <typename... Args>
    ProxyWordCollator(ParentType& parent, Args&&... args) noexcept
        : Parent(parent), m_collator{std::forward<Args>(args)...} {}

    bool operator()(const ProxyWord& lp, const ProxyWord& rp) const noexcept {
        return m_collator(load(lp), load(rp));
    }

    bool operator()(TextView lstr, const ProxyWord& rp) const noexcept {
        return m_collator(lstr, load(rp));
    }

    bool operator()(const ProxyWord& lp, TextView rstr) const noexcept {
        return m_collator(load(lp), rstr);
    }

    CollatorType m_collator;
};

template <typename CollatorT, typename ViewCollatorT, typename CharT = char>
using PolyProxyWordCollator = ProxyWordCollator<CollatorT, ViewCollatorT>;

// Alias two collators, one case aware (1:1), the other case normalized (1:n) -
template <typename AllocT = std::allocator<char>>
using ProxyCaseCollator =
    ProxyWordCollator<std::less<TextView>, string::Case<char>, AllocT>;
using PolyProxyCaseCollator =
    PolyProxyWordCollator<std::less<TextView>, string::Case<char>>;

template <typename AllocT = std::allocator<char>>
using ProxyNoCaseCollator =
    ProxyWordCollator<string::icu::MultibyteNoCaseCollator,
                      string::NoCase<char>, AllocT>;
using PolyProxyNoCaseCollator =
    PolyProxyWordCollator<string::icu::MultibyteNoCaseCollator,
                          string::NoCase<char>>;

// Declare the primary indexes
template <template <typename... Arg> typename AllocT = memory::ViewAllocator>
using FlatWordDocIdSetIndex = FlatMap<WordId, ProxyDocIdSet, std::less<WordId>,
                                      AllocT<Pair<WordId, ProxyDocIdSet>>>;

template <template <typename... Arg> typename AllocT = memory::ViewAllocator>
using FlatDocWordIdListIndex = FlatMap<DocId, ProxyWordIdList, std::less<DocId>,
                                       AllocT<Pair<DocId, ProxyWordIdList>>>;

template <template <typename... AllocArgs> typename AllocT =
              memory::ViewAllocator>
using FlatDocHashIndex =
    FlatMap<DocHash, DocId, std::less<DocHash>, AllocT<Pair<DocHash, DocId>>>;

template <template <typename... AllocArgs> typename AllocT =
              memory::ViewAllocator>
using FlatDocIdIndex =
    FlatMap<DocId, DocHash, std::less<DocId>, AllocT<Pair<DocId, DocHash>>>;

template <template <typename... AllocArgs> typename AllocT =
              memory::ViewAllocator>
using FlatWordIdIndex = FlatMap<WordId, ProxyWord, std::less<WordId>,
                                AllocT<Pair<WordId, ProxyWord>>>;

template <template <typename... Args> typename AllocT = memory::ViewAllocator>
using FlatWordCaseIndex =
    FlatMap<ProxyWord, WordId, ProxyCaseCollator<AllocT<char>>,
            AllocT<Pair<ProxyWord, WordId>>>;

template <template <typename... Args> typename AllocT = memory::ViewAllocator>
using FlatWordNoCaseIndex =
    FlatMultiMap<ProxyWord, WordId, ProxyNoCaseCollator<AllocT<char>>,
                 AllocT<Pair<ProxyWord, WordId>>>;

using DocMetadataIndex = std::map<DocId, std::vector<WordId>>;
using WordDocIdSetIndex = std::map<WordId, FlatSet<DocId>>;
using DocWordIdListIndex = std::map<DocId, ProxyWordIdList>;
using DocHashIndex = std::map<DocHash, DocId>;
using DocIdIndex = std::map<DocId, CRef<DocHash>>;
using WordIdIndex = std::map<WordId, ProxyWord>;

using PolyDocMetadataIndex = PmrMap<DocId, std::vector<WordId>>;

#ifdef USE_BUCKET_ARRAY
using PolyWordDocIdSetIndex = WordDocBucketArray;
#else
using PolyWordDocIdSetIndex = PmrMap<WordId, FlatSet<DocId>>;
#endif

using PolyDocWordIdListIndex = PmrMap<DocId, ProxyWordIdList>;
using PolyDocHashIndex = PmrMap<DocHash, DocId>;
using PolyDocIdIndex = PmrMap<DocId, CRef<DocHash>>;
using PolyWordIdIndex = PmrMap<WordId, ProxyWord>;

template <template <typename... Args> typename AllocT = std::allocator>
using WordCaseIndex =
    std::map<ProxyWord, WordId, ProxyCaseCollator<AllocT<char>>,
             AllocT<Pair<const ProxyWord, WordId>>>;
using PolyWordCaseIndex = PmrMap<ProxyWord, WordId, PolyProxyCaseCollator>;

template <template <typename... Args> typename AllocT = std::allocator>
using WordNoCaseIndex =
    std::multimap<ProxyWord, WordId, ProxyNoCaseCollator<AllocT<char>>,
                  AllocT<Pair<const ProxyWord, WordId>>>;
using PolyWordNoCaseIndex =
    PmrMultimap<ProxyWord, WordId, PolyProxyNoCaseCollator>;

using WordAddCallback = Function<void(CountSize countSize)>;

}  // namespace engine::index::db
