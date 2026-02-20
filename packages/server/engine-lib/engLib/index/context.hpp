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

namespace engine::index {
// Do not continue matching multiword searches or gathering match context across
// metadata boundaries
inline bool isMultiwordBoundary(WordId value) noexcept {
    switch (_cast<index::db::ReservedWordId>(value)) {
        case index::db::ReservedWordId::MetadataBlockStart:
            // Separates document text from metadata
        case index::db::ReservedWordId::MetadataValueEnd:
            // Separates metadata key-value pairs
            // Allow crossing the boundary between key and value within the same
            // pair, though
            return true;

        default:
            return false;
    }
}

// Normalize vertical whitespace to a space so that we don't have linefeeds in
// match contexts
template <file::Mode WordDbModeT>
TextView renderContextWord(const db::WordDb<WordDbModeT>& wordDb,
                           WordId wordId) noexcept {
    auto word = wordDb.lookupWord(wordId);
    if (word.length() == 1 && string::isVerticalSpace(word[0])) return " "_tv;
    return word;
}

// Build a context from a range, stopping at metadata boundaries
template <file::Mode WordDbModeT>
Text renderContext(const db::WordDb<WordDbModeT>& wordDb,
                   const WordIdListReturnType& docWordIds, size_t matchStart,
                   size_t matchLength, size_t contextStart, size_t contextEnd,
                   bool trim = true) noexcept {
    Text context;
    for (auto i = contextStart; i < contextEnd; ++i) {
        const auto wordId = docWordIds[i];

        // Context stops at metadata boundaries
        if (isMultiwordBoundary(wordId)) {
            if (contextStart < matchStart) {
                // If we're before the match, clear any previous context and
                // keep going
                context.clear();
            } else {
                // Otherwise, assume we're after the match and return the
                // context we have
                ASSERT(contextStart >= matchStart + matchLength);
                break;
            }
        } else
            context += renderContextWord(wordDb, wordId);
    }

    // By default, trim each context component to remove any captured whitespace
    if (trim) context.trim();
    return context;
};

// Build match context (takes the doc's WorIdList instead of doc ID to
// accommodate search::QueryCtx's cache
template <file::Mode WordDbModeT>
match::MatchContext getMatchContext(const db::WordDb<WordDbModeT>& wordDb,
                                    const WordIdListReturnType& docWordIds,
                                    size_t matchStart, size_t matchLength,
                                    size_t words, bool includeMatch = true,
                                    bool trim = true) noexcept {
    match::MatchContext context;

    // Find leading context (skip if the match is at the start of the document)
    if (matchStart) {
        size_t leadingContextStart = {};
        // We only have to count the actual words if the match starts more than
        // 10 words in
        if (matchStart > words) {
            // Working backwards from the match, count the number of words until
            // we reach 10
            size_t leadingWordsIncluded = {};
            for (leadingContextStart = matchStart - 1; leadingContextStart > 0;
                 --leadingContextStart) {
                if (db::isWord(docWordIds[leadingContextStart])) {
                    // If we got 10 words, done (break rather than letting
                    // leadingContextStart decrement or we'll get an unwanted
                    // leading token)
                    if (++leadingWordsIncluded >= words) break;
                }
            }
        }

        // Now we know the range of the leading context
        context.leading =
            renderContext(wordDb, docWordIds, matchStart, matchLength,
                          leadingContextStart, matchStart, trim);
    }

    // This one's easy
    if (includeMatch)
        context.match =
            renderContext(wordDb, docWordIds, matchStart, matchLength,
                          matchStart, matchStart + matchLength, trim);

    // Find trailing context (skip if match is at the end of the document)
    if (matchStart + matchLength < docWordIds.size()) {
        const size_t trailingContextStart = matchStart + matchLength;
        size_t trailingContextEnd = trailingContextStart;
        // We only have to count the actual words if the match ends more then 10
        // words before the end of the document
        if (trailingContextEnd + words + 1 < docWordIds.size()) {
            // Working forwards from the match, count the number of words until
            // we reach 10
            auto trailingWordsIncluded = 0;
            for (; trailingContextEnd < docWordIds.size() &&
                   trailingWordsIncluded < words;
                 ++trailingContextEnd) {
                // Don't break early-- we want trailingContextEnd to point at
                // one past the final word
                if (db::isWord(docWordIds[trailingContextEnd]))
                    ++trailingWordsIncluded;
            }
        } else
            trailingContextEnd = docWordIds.size();

        // Now we know the range of the trailing context
        context.trailing =
            renderContext(wordDb, docWordIds, matchStart, matchLength,
                          trailingContextStart, trailingContextEnd, trim);
    }

    return context;
}

template <file::Mode WordDbModeT>
match::MatchContext getMatchContext(const db::WordDb<WordDbModeT>& wordDb,
                                    DocId docId, size_t matchStart,
                                    size_t matchLength, size_t words,
                                    bool includeMatch = true,
                                    bool trim = true) noexcept {
    return getMatchContext(wordDb, wordDb.lookupDocWordIdList(docId),
                           matchStart, matchLength, words, includeMatch, trim);
}

}  // namespace engine::index