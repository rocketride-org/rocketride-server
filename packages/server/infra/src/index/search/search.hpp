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

// Check if any words exist in the document, words are looked up case
// insensitive
inline bool anyExist(QueryCtx &ctx, const WordIdSet &wordIds) noexcept {
    if (ctx.docWordIdList().empty()) return false;

    if (wordIds.empty()) return false;

    // Now see if any the words are there
    bool matches = false;
    for (auto &wordId : wordIds) {
        // Loop will execute once at most unless context is requested
        for (auto it = _findIf(ctx.docWordIdList().begin(),
                               ctx.docWordIdList().end(), wordId);
             it != ctx.docWordIdList().end();
             it = _findIf(++it, ctx.docWordIdList().end(), wordId)) {
            // Add context if requested; otherwise, done
            if (!ctx.addContext(it - ctx.docWordIdList().begin(), 1))
                return true;

            // Note the search matches; keep looking for more match contexts
            matches = true;
        }
    }

    return matches;
}

// Check if all words exist in the document, words are looked up case
// insensitive
inline bool allExist(QueryCtx &ctx,
                     const WordVariationList &variations) noexcept {
    if (ctx.docWordIdList().empty()) return false;

    // Empty set or any word missing variations; done
    if (variations.empty() || _anyOf(variations, [](const WordIdList &wordIds) {
            return wordIds.empty();
        }))
        return false;

    // Record indexes of matching words to add to context once match is
    // confirmed
    const bool keepContext = ctx.wantsContext();
    std::vector<size_t> matchIndexes;
    if (keepContext) matchIndexes.reserve(variations.size());

    // Check if at least one case variation of each word exists in the document
    for (auto &wordIds : variations) {
        // Search the document for each word ID
        bool found = false;
        for (auto &wordId : wordIds) {
            for (auto it = _findIf(ctx.docWordIdList().begin(),
                                   ctx.docWordIdList().end(), wordId);
                 it != ctx.docWordIdList().end();
                 it = _findIf(++it, ctx.docWordIdList().end(), wordId)) {
                found = true;

                // If context was requested, record the match index and keep
                // looking; otherwise, done
                if (keepContext)
                    matchIndexes.push_back(
                        std::distance(ctx.docWordIdList().begin(), it));
                else
                    break;
            }
        }

        // If any word isn't found, done
        if (!found) return false;
    }

    // Found all of them; add context if requested
    for (auto &matchIndex : matchIndexes) {
        if (!ctx.addContext(matchIndex, 1)) break;
    }

    return true;
}

// Lookup a series of tokens, all have to be in series for this to match, case
// insensitive
inline bool phraseExists(QueryCtx &ctx,
                         const WordVariationList &phrase) noexcept {
    if (ctx.docWordIdList().empty()) return false;

    // Empty phrase or any word missing variations; done
    if (phrase.empty() || _anyOf(phrase, [](const WordIdList &wordIds) {
            return wordIds.empty();
        }))
        return false;

    // Phrases longer than the document never match
    if (phrase.size() > ctx.docWordIdList().size()) return false;

    // Establish last possible match position (end element is inclusive)
    const auto end = ctx.docWordIdList().end() - (phrase.size() - 1);

    bool matches = false;
    for (auto docPos = ctx.docWordIdList().begin();
         docPos != ctx.docWordIdList().end(); ++docPos) {
        // Search docWordIdList for the first word in the phrase
        docPos =
            std::find_first_of(docPos, end, phrase[0].begin(), phrase[0].end());
        if (docPos == end) return matches;

        // Try to match the phrase, ignoring symbols and whitespace
        // Note that if there are any symbols in the phrase itself, it'll never
        // match
        auto phrasePos = phrase.begin() + 1;
        auto matchPos = docPos + 1;
        for (;
             matchPos != ctx.docWordIdList().end() && phrasePos != phrase.end();
             ++matchPos) {
            // Do not continue matching across metadata boundaries
            if (isMultiwordBoundary(*matchPos)) break;

            // Skip any document token that's not a word
            if (!db::isWord(*matchPos)) continue;

            // Doesn't match; keep looking through the document
            if (!_anyOf(*phrasePos, *matchPos)) break;

            // Matches; keep checking
            ++phrasePos;
        }

        // If we matched the whole phrase, we're done
        if (phrasePos == phrase.end()) {
            matches = true;
            if (!ctx.addContext(docPos - ctx.docWordIdList().begin(),
                                matchPos - docPos))
                return true;
        }
    }

    return matches;
}

inline bool sequenceExists(QueryCtx &ctx, const WordIdList &sequence) noexcept {
    if (ctx.docWordIdList().empty()) return false;

    // Empty sequence never matches
    if (sequence.empty()) return false;

    // Sequences longer than the document never match
    if (sequence.size() > ctx.docWordIdList().size()) return false;

    // Search the document for the whole sequence
    // Ignore metadata boundaries since either the sequence shouldn't include
    // them (i.e. is a phrase) or was intended to match the boundary itself
    bool matches = false;
    for (auto docPos =
             std::search(ctx.docWordIdList().begin(), ctx.docWordIdList().end(),
                         sequence.begin(), sequence.end());
         docPos != ctx.docWordIdList().end(); ++docPos) {
        matches = true;
        if (!ctx.addContext(docPos - ctx.docWordIdList().begin(),
                            sequence.size()))
            return true;
    }

    return matches;
}

inline bool existsNear(QueryCtx &ctx,
                       const WordVariationList &variations) noexcept {
    if (ctx.docWordIdList().empty()) return false;

    // Empty set or any word missing variations; done
    if (variations.empty() || _anyOf(variations, [](const WordIdList &wordIds) {
            return wordIds.empty();
        }))
        return false;

    // If we have just one word, use allExist
    if (variations.size() == 1) return allExist(ctx, variations);

    // If there are more terms than exist in the document, we're done
    if (variations.size() > ctx.docWordIdList().size()) return false;
    // If there are the same number of variations in the document as the number
    // of terms, it's just an allExists search
    else if (variations.size() == ctx.docWordIdList().size())
        return allExist(ctx, variations);

    // Search docWordIdList for variations of word W, starting from offset I and
    // searching +/- NearWordLimit
    auto findNearbyWord = [&](const WordIdList &wordVariations, auto docPos) {
        // Search backwards from the match, ignoring symbols and whitespace
        if (docPos != ctx.docWordIdList().begin()) {
            size_t variationsSearched = 0;
            for (auto searchPos = docPos - 1;
                 variationsSearched < NearWordLimit; --searchPos) {
                // Do not continue matching across metadata boundaries
                if (isMultiwordBoundary(*searchPos)) break;

                if (db::isWord(*searchPos)) {
                    if (_anyOf(wordVariations, *searchPos)) return searchPos;
                    ++variationsSearched;
                }

                if (searchPos == ctx.docWordIdList().begin()) break;
            }
        }

        // Search forwards from the match, ignoring symbols and whitespace
        size_t variationsSearched = 0;
        for (auto searchPos = docPos + 1;
             searchPos != ctx.docWordIdList().end() &&
             variationsSearched < NearWordLimit;
             ++searchPos) {
            // Do not continue matching across metadata boundaries
            if (isMultiwordBoundary(*searchPos)) break;

            if (db::isWord(*searchPos)) {
                if (_anyOf(wordVariations, *searchPos)) return searchPos;
                ++variationsSearched;
            }
        }

        return ctx.docWordIdList().end();
    };

    // Search the document for the first token
    bool matches = false;
    for (auto docPos = ctx.docWordIdList().begin();
         docPos != ctx.docWordIdList().end(); ++docPos) {
        docPos = std::find_first_of(docPos, ctx.docWordIdList().end(),
                                    variations[0].begin(), variations[0].end());
        if (docPos == ctx.docWordIdList().end()) return matches;

        // Get the position we are going to highlight
        auto matchStart = docPos;
        auto matchEnd = docPos;

        // Now, check all the variations after it
        auto currentWordPos = docPos;
        size_t wordIndex = 1;
        for (; wordIndex < variations.size(); ++wordIndex) {
            // Check the variations within the range to see if the next word we
            // are looking for is there
            auto foundAt =
                findNearbyWord(variations[wordIndex], currentWordPos);

            // If we didn't find it nearby, done
            if (foundAt == ctx.docWordIdList().end()) break;

            // Update context boundaries
            matchStart = std::min(matchStart, foundAt);
            matchEnd = std::max(matchEnd, foundAt);

            // Update search position
            currentWordPos = foundAt;
        }

        // It matches!
        if (wordIndex == variations.size()) {
            matches = true;
            if (!ctx.addContext(matchStart - ctx.docWordIdList().begin(),
                                (matchEnd - matchStart) + 1))
                return true;
        }
    }

    return matches;
}

inline bool matchesGlob(QueryCtx &ctx, const globber::Glob &glob) noexcept {
    if (ctx.docWordIdList().empty()) return false;

    bool matches = false;
    // Iterate through the words and test the pattern on each word (rely on the
    // glob to take care of case insensitivity)
    for (auto wordIndex = 0; wordIndex < ctx.docWordIdList().size();
         ++wordIndex) {
        if (auto word = ctx.db().lookupWord(ctx.docWordIdList()[wordIndex])) {
            if (glob.matches(word)) {
                // Matches!  Add context and check if done
                matches = true;
                if (!ctx.addContext(wordIndex, 1)) return true;
            }
        }
    }

    return matches;
}

inline bool matchesRegularExpression(QueryCtx &ctx,
                                     const std::regex &regex) noexcept {
    if (ctx.docWordIdList().empty()) return false;

    bool matches = false;
    for (auto wordIndex = 0; wordIndex < ctx.docWordIdList().size();
         ++wordIndex) {
        if (auto word = ctx.db().lookupWord(ctx.docWordIdList()[wordIndex])) {
            if (std::regex_match(word.begin(), word.end(), regex)) {
                matches = true;
                if (!ctx.addContext(wordIndex, 1)) return true;
            }
        }
    }

    return matches;
}

// Builds a list of sets, each containing all possible variations of a given
// word, for case-insensitive lookup
template <typename ContainerT>
inline Opt<WordVariationList> lookupWordVariations(
    const WordDbRead &db, const ContainerT &words) noexcept {
    WordVariationList variations;
    variations.reserve(words.size());
    for (auto &word : words) {
        if (auto wordIds = db.lookupWordIds(word); !wordIds.empty())
            variations.emplace_back(_mv(wordIds));
        // No variation of the word was found; done
        else
            return NullOpt;
    }
    ASSERT(variations.size() == words.size());
    return variations;
}

inline WordIdSet lookupWordIds(const WordDbRead &db,
                               const std::vector<Text> &words) noexcept {
    WordIdSet wordIds;
    for (auto &word : words) _addTo(wordIds, db.lookupWordIds(word));
    return wordIds;
}

inline Opt<WordIdList> lookupSequence(const WordDbRead &db,
                                      const std::vector<Text> &words) noexcept {
    WordIdList sequence;
    sequence.reserve(words.size());
    for (auto &word : words) {
        auto wordId = db.lookupWordId(word);
        if (!wordId) return NullOpt;
        sequence.push_back(wordId);
    }
    return sequence;
}

}  // namespace engine::index::search
