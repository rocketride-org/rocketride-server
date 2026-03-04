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
// The read word db abstracts the local and remote db implementations
template <>
class WordDb<file::Mode::READ> {
public:
    _const auto LogLevel = Lvl::WordDb;

    WordDb() = default;

    WordDb(const file::Path &path) noexcept(false) { *open(path); }

    ~WordDb() noexcept { close(); }

    TextView lookupWord(WordId id) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.lookupWord(id);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.lookupWord(id);
                                 },
                                 [&](std::monostate) noexcept -> TextView {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    TextView lookupWord(const ProxyWord &addr) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.lookupWord(addr);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.lookupWord(addr);
                                 },
                                 [&](std::monostate) noexcept -> TextView {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    WordIdList lookupWordIds(iTextView word) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.lookupWordIds(word);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.lookupWordIds(word);
                                 },
                                 [&](std::monostate) noexcept -> WordIdList {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    WordId lookupWordId(TextView word) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.lookupWordId(word);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.lookupWordId(word);
                                 },
                                 [&](std::monostate) noexcept -> WordId {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    DocIdList lookupDocIds(WordId wordId) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.lookupDocIds(wordId);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.lookupDocIds(wordId);
                                 },
                                 [&](std::monostate) noexcept -> DocIdList {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    template <typename ContainerT,
              typename = std::enable_if<traits::IsContainerV<ContainerT>>>
    void lookupDocIds(WordId wordId, ContainerT &out) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     db.lookupDocIds(wordId, out);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     db.lookupDocIds(wordId, out);
                                 },
                                 [&](std::monostate) noexcept {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    DocId lookupDocId(const DocHash &hash) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.lookupDocId(hash);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.lookupDocId(hash);
                                 },
                                 [&](std::monostate) noexcept -> DocId {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    Opt<DocHash> lookupDocHash(DocId docId) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.lookupDocHash(docId);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.lookupDocHash(docId);
                                 },
                                 [&](std::monostate) noexcept -> Opt<DocHash> {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    bool hasDocId(DocId docId) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.hasDocId(docId);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.hasDocId(docId);
                                 },
                                 [&](std::monostate) noexcept -> bool {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    WordIdListReturnType lookupDocWordIdList(DocId docId) const noexcept {
        return _visit(
            overloaded{[&](const internal::Local &db) noexcept {
                           return db.lookupDocWordIdList(docId);
                       },
                       [&](const internal::Remote &db) noexcept {
                           return db.lookupDocWordIdList(docId);
                       },
                       [&](std::monostate) noexcept -> WordIdListReturnType {
                           dev::fatality(_location, "Word DB not opened");
                       }},
            m_db);
    }

    ErrorOr<Metadata> getDocMetadata(DocId docId) const noexcept {
        return _visit(
            overloaded{[&](const internal::Local &db) noexcept {
                           return db.getDocMetadata(docId);
                       },
                       [&](const internal::Remote &db) noexcept {
                           return db.getDocMetadata(docId);
                       },
                       [&](std::monostate) noexcept -> ErrorOr<Metadata> {
                           dev::fatality(_location, "Word DB not opened");
                       }},
            m_db);
    }

    template <typename T>
    void lookupDocMetadataWordIds(DocId docId, T &cnt) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     db.lookupDocMetadataWordIds(docId, cnt);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     db.lookupDocMetadataWordIds(docId, cnt);
                                 },
                                 [&](std::monostate) noexcept {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    size_t docCount() const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.docCount();
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.docCount();
                                 },
                                 [&](std::monostate) noexcept -> size_t {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    size_t docWordCount(DocId docId) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.docWordCount(docId);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.docWordCount(docId);
                                 },
                                 [&](std::monostate) noexcept -> size_t {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    size_t docWordCount() const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.docWordCount();
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.docWordCount();
                                 },
                                 [&](std::monostate) noexcept -> size_t {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    size_t wordCount() const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.wordCount();
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.wordCount();
                                 },
                                 [&](std::monostate) noexcept -> size_t {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    size_t uniqueWordCount() const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.uniqueWordCount();
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.uniqueWordCount();
                                 },
                                 [&](std::monostate) noexcept -> size_t {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    size_t wordStringsSize() const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.wordStringsSize();
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.wordStringsSize();
                                 },
                                 [&](std::monostate) noexcept -> size_t {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    const FlatWordIdIndex<> &wordIdIndex() const noexcept {
        return _visit(
            overloaded{
                [&](const internal::Local &db) noexcept
                    -> const FlatWordIdIndex<> & { return db.wordIdIndex(); },
                [&](const internal::Remote &db) noexcept
                    -> const FlatWordIdIndex<> & { return db.wordIdIndex(); },
                [&](std::monostate) noexcept -> const FlatWordIdIndex<> & {
                    dev::fatality(_location, "Word DB is not opened");
                }},
            m_db);
    }

#ifdef KEEP_CASE_INDEX
    const FlatWordCaseIndex<> &wordCaseIndex() const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept
                                     -> const FlatWordCaseIndex<> & {
                                     return db.wordCaseIndex();
                                 },
                                 [&](const internal::Remote &db) noexcept
                                     -> const FlatWordCaseIndex<> & {
                                     return db.wordCaseIndex();
                                 },
                                 [&](const std::monostate) noexcept
                                     -> const FlatWordCaseIndex<> & {
                                     dev::fatality(_location,
                                                   "Word DB is not opened");
                                 }},
                      m_db);
    }
#endif

    const FlatWordNoCaseIndex<> &wordNoCaseIndex() const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept
                                     -> const FlatWordNoCaseIndex<> & {
                                     return db.wordNoCaseIndex();
                                 },
                                 [&](const internal::Remote &db) noexcept
                                     -> const FlatWordNoCaseIndex<> & {
                                     return db.wordNoCaseIndex();
                                 },
                                 [&](const std::monostate) noexcept
                                     -> const FlatWordNoCaseIndex<> & {
                                     dev::fatality(_location,
                                                   "Word DB is not opened");
                                 }},
                      m_db);
    }

    const FlatDocIdIndex<> &docIdIndex() const noexcept {
        return _visit(
            overloaded{
                [&](const internal::Local &db) noexcept
                    -> const FlatDocIdIndex<> & { return db.docIdIndex(); },
                [&](const internal::Remote &db) noexcept
                    -> const FlatDocIdIndex<> & { return db.docIdIndex(); },
                [&](std::monostate) noexcept -> const FlatDocIdIndex<> & {
                    dev::fatality(_location, "Word DB is not opened");
                }},
            m_db);
    }

    const FlatWordDocIdSetIndex<> &wordDocIdSetIndex() const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept
                                     -> const FlatWordDocIdSetIndex<> & {
                                     return db.wordDocIdSetIndex();
                                 },
                                 [&](const internal::Remote &db) noexcept
                                     -> const FlatWordDocIdSetIndex<> & {
                                     return db.wordDocIdSetIndex();
                                 },
                                 [&](std::monostate) noexcept
                                     -> const FlatWordDocIdSetIndex<> & {
                                     dev::fatality(_location,
                                                   "Word DB is not opened");
                                 }},
                      m_db);
    }

    size_t docWordIdListCount(const DocHash &docHash) const noexcept {
        return _visit(overloaded{[&](const internal::Local &db) noexcept {
                                     return db.docWordIdListCount(docHash);
                                 },
                                 [&](const internal::Remote &db) noexcept {
                                     return db.docWordIdListCount(docHash);
                                 },
                                 [&](std::monostate) noexcept -> size_t {
                                     dev::fatality(_location,
                                                   "Word DB not opened");
                                 }},
                      m_db);
    }

    Stats stats() const noexcept {
        return _visit(
            overloaded{
                [&](const internal::Local &db) noexcept { return db.stats(); },
                [&](const internal::Remote &db) noexcept { return db.stats(); },
                [&](std::monostate) noexcept -> Stats {
                    dev::fatality(_location, "Word DB not opened");
                }},
            m_db);
    }

    Error open(const file::Path &path) noexcept {
        LOGT("Opening local word DB", path);
        return m_db.emplace<internal::Local>().open(path);
    }

    Error open(const Url &url) noexcept {
        if (url.protocol() == stream::datafile::Type) {
            // Get the local path
            file::Path path;
            if (auto ccode = Url::toPath(url, path)) return ccode;

            // For now, get the local path
            return open(path);
        } else if (url.protocol() == stream::datanet::Type) {
            // Open the word stream
            auto stream = stream::openStream(url, stream::Mode::READ);
            if (!stream) return stream.ccode();

            // For now, open word DB from the stream
            return open(_mv(*stream));
        } else {
            return APERRT(Ec::InvalidParam, "Protocol not supported",
                          url.protocol());
        }
    }

    Error open(StreamPtr stream) noexcept {
        LOGT("Opening word DB stream", stream);
        return m_db.emplace<internal::Remote>().open(_mv(stream));
    }

    void close() noexcept {
        _visit(overloaded{[&](internal::Local &db) noexcept { db.close(); },
                          [&](internal::Remote &db) noexcept { db.close(); },
                          [&](std::monostate) noexcept {}},
               m_db);
        m_db = std::monostate{};
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "index::db::WordDb";
    }

private:
    // We either construct a local db, or a remote one, based on the open params
    Variant<std::monostate, internal::Local, internal::Remote> m_db;
};
}  // namespace engine::index::db
