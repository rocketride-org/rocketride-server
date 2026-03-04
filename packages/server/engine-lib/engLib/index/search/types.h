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

namespace engine::index::search {

_const auto NearWordLimit = 10;

// Options for interacting with the word store/words
struct Options {
    enum {
        DefaultObjectLimit = 100,
        DefaultContextWords = 10,
        DefaultContextCount = 5,
    };

    size_t objectLimit = DefaultObjectLimit;
    bool wantsContext = false;
    size_t contextWords = DefaultContextWords;
    size_t contextCount = DefaultContextCount;
    bool documentsFiltered = false;

    auto __jsonSchema() const noexcept {
        return json::makeSchema(objectLimit, "objectLimit", wantsContext,
                                "wantsContext", contextWords, "contextWords",
                                contextCount, "contextCount");
    }
};

class QueryCtx {
public:
    _const auto LogLevel = Lvl::Search;

    QueryCtx(const WordDbRead& db, DocId docId, Opt<Options> opts = {}) noexcept
        : m_db(db),
          m_docId(docId),
          m_opts(opts ? *opts : Options()),
          m_contexts{json::arrayValue} {}

    ~QueryCtx() = default;
    QueryCtx(const QueryCtx&) = default;
    QueryCtx(QueryCtx&&) = default;

    const WordDbRead& db() const noexcept { return m_db; }

    DocId docId() const noexcept { return m_docId; }

    const Options& opts() const noexcept { return m_opts; }

    const auto& docWordIdList() const noexcept {
        // Load doc word ID's if needed
        if (!m_docWordIdList)
            m_docWordIdList = m_db.lookupDocWordIdList(m_docId);
        return *m_docWordIdList;
    }

    auto lookupWord(WordId id) const noexcept { return m_db.lookupWord(id); }

    auto& contexts() noexcept { return m_contexts; }

    const auto& contexts() const noexcept { return m_contexts; }

    bool wantsContext() const noexcept {
        // If context is disabled for the current search operator (e.g. because
        // it's a child of a not operator), done
        if (m_contextDisabled) return false;

        // If context wasn't asked for, done
        if (!m_opts.wantsContext) return false;

        // If the context was asked for but the configuration is invalid, log
        // and done
        if (!m_opts.contextWords || !m_opts.contextCount) {
            LOGT(
                "Search result context requested but configuration is "
                "invalid!");
            return false;
        }

        // If we've hit the limit on contexts, done
        if (m_contexts.size() >= m_opts.contextCount) return false;

        return true;
    }

    void setContextDisabled(bool value) noexcept { m_contextDisabled = value; }

    bool addContext(size_t matchStart, size_t matchLength) noexcept {
        if (!wantsContext()) return false;

        auto context = getMatchContext(m_db, docWordIdList(), matchStart,
                                       matchLength, m_opts.contextWords);
        m_contexts.append(_tj(context));
        return true;
    }

private:
    const WordDbRead& m_db;
    const DocId m_docId;
    const Options m_opts;

    mutable Opt<WordIdListReturnType> m_docWordIdList;
    bool m_contextDisabled = false;
    json::Value m_contexts;
};

}  // namespace engine::index::search
