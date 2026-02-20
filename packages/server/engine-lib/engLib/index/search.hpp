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
inline ErrorOr<std::vector<Text>> tokenize(TextView text) noexcept {
    // When tokenizing search terms, we want to strip symbols and whitespace
    // tokenizer.setText(text, parse::SymbolAndWhitespaceMode::STRIP);
    return Error{};
}

inline bool searchWords(search::QueryCtx& ctx,
                        const search::CompiledOps& ops) noexcept(false) {
    using namespace engine::index::search;

    // Cache results per thread, to improve responsiveness as the result heap
    // will get re-used the next time the thread searches for something
    _thread_local async::Tls<Results> results(_location);
    results->reset();

    // If we're using filtering, then we know this document matched all
    // operators that don't require loading the doc words (i.e. all except Near
    // or Phrase).  If that's true of _all_ the operators, then we're done! This
    // optimization isn't possible if match context is requested, though-- we
    // need doc words for that.
    if (ctx.opts().documentsFiltered && !ctx.wantsContext() &&
        _allOf(ops,
               [](auto& op) { return !doesOpEvaluationRequireDocWords(op); }))
        return true;

    // Run through the compiled opcodes
    for (const auto& op : ops) {
        // Is it a search (i.e. not a logical or ignored) op code?
        if (results->evaluateOpCode(op.opCode)) continue;

        // Disable result context if the operator doesn't allow it (e.g. if it's
        // a child of a Not operator)
        ctx.setContextDisabled(op.contextDisabled);

        // Evaluate the operator
        bool result = false;

        switch (op.opCode) {
            case OpCode::In:
                result = allExist(ctx, op.wordVariations);
                break;

            case OpCode::Near:
                result = existsNear(ctx, op.wordVariations);
                break;

            case OpCode::Any:
                result = anyExist(ctx, op.wordIds);
                break;

            case OpCode::Phrase:
                result = phraseExists(ctx, op.wordVariations);
                break;

            case OpCode::Glob:
            case OpCode::Like:
                result = matchesGlob(ctx, op.glob);
                break;

            case OpCode::Regexp:
                result = matchesRegularExpression(ctx, op.regex);
                break;

            default:
                // Unhandled opcode (shouldn't be possible with compiled ops)
                APERRL_THROW(Search, Ec::Bug, "Unhandled opcode",
                             _cast<int>(op.opCode));
                break;
        }

        // Add the result to the stack
        results->pushResult(result);
    }

    // Final result
    const bool result = results->popResult();

    // Is this possible?  It probably means something's borked
    if (!results->empty())
        LOG(Search, "Result stack not empty after operator evaluation");

    // If the document didn't match the whole query, but some criteria did match
    // and we collected some match contexts, discard them
    if (!result) ctx.contexts().clear();

    return result;
}

inline bool searchWords(search::QueryCtx& ctx, const search::CompiledOps& ops,
                        Error& ccode) noexcept {
    auto res = _call([&] { return searchWords(ctx, ops); });
    if (res.check()) {
        ccode = _mv(res.ccode());
        return false;
    }
    return res.value();
}

inline DocIdSet selectDocsContainingAllWords(
    const WordDbRead& db, const WordVariationList& variations) noexcept {
    using namespace engine::index::search;

    // Empty set or any word missing variations; done
    if (variations.empty() || _anyOf(variations, [](const WordIdList& wordIds) {
            return wordIds.empty();
        }))
        return {};

    // Find the ID's of all the documents that contain at least one of each of
    // the variations
    DocIdSet docsContainingAllWords;
    for (auto& wordIds : variations) {
        // Build a set of all documents that contain any variation of this word
        DocIdSet docsContainingThisWord;
        for (auto wordId : wordIds)
            db.lookupDocIds(wordId, docsContainingThisWord);
        if (docsContainingThisWord.empty()) {
            // Shouldn't be possible
            LOG(Search, "Word found in db but no documents contain the word");
            return {};
        }

        if (!docsContainingAllWords.empty()) {
            // Intersect the sets, giving us the set of documents that match all
            // previous words and this word
            DocIdSet merged;
            std::set_intersection(
                docsContainingAllWords.begin(), docsContainingAllWords.end(),
                docsContainingThisWord.begin(), docsContainingThisWord.end(),
                std::inserter(merged, merged.end()));
            docsContainingAllWords = _mv(merged);

            // If no docs contained all of the words, done
            if (docsContainingAllWords.empty()) return {};
        } else
            docsContainingAllWords = _mv(docsContainingThisWord);
    }

    return docsContainingAllWords;
}

template <typename ContainerT>
inline DocIdSet selectDocsContainingAnyWordId(
    const WordDbRead& db, const ContainerT& wordIds) noexcept {
    // Find the ID's of all the documents that contain any of the words
    DocIdSet matchingDocs;
    for (auto& wordId : wordIds) db.lookupDocIds(wordId, matchingDocs);
    return matchingDocs;
}

inline DocIdSet selectDocsContainingGlobMatch(
    const WordDbRead& db, const globber::Glob& glob) noexcept {
    using namespace ap::globber;

    WordIdList matchingWordIds;
    switch (glob.mode()) {
        case Glob::Mode::STARTS_WITH: {
            auto& prefix = glob.rule(0).value;
            ASSERT(!prefix.empty());

            for (auto it = db.wordNoCaseIndex().lower_bound(prefix);
                 it != db.wordNoCaseIndex().end(); ++it) {
                auto word = db.lookupWord(it->first);
                if (word.startsWith(prefix, false))
                    matchingWordIds.push_back(it->second);
                else
                    break;
            }
            break;
        }

        case Glob::Mode::GLOB_EXACT:
            // The glob contains no wildcards, e.g. "cat"
            matchingWordIds = db.lookupWordIds(glob.pattern());
            break;

        case Glob::Mode::ENDS_WITH:
        case Glob::Mode::CONTAINS:
        case Glob::Mode::GLOB:
            // Walk all the words in the DB
            for (auto& [wordId, proxy] : db.wordIdIndex()) {
                auto word = db.lookupWord(proxy);
                if (glob.matches(word)) matchingWordIds.push_back(wordId);
            }
            break;

        case Glob::Mode::ALWAYS_MATCHED: {
            // If the globs matches everything, return all documents
            DocIdSet allDocIds;
            for (auto& entry : db.docIdIndex()) allDocIds.insert(entry.first);
            return allDocIds;
        }

        default:
            LOG(Search, "Found unexpected glob mode", glob.mode(),
                glob.pattern());
            break;
    }

    // Find the ID's of all the documents that contain any of the words
    return selectDocsContainingAnyWordId(db, matchingWordIds);
}

inline DocIdSet selectDocsContainingRegexMatch(const WordDbRead& db,
                                               const std::regex& regex,
                                               TextView regexSource) noexcept {
    // std::regex doesn't store a copy of the original expression, so we need
    // both the compiled expression and its original source Determine how much
    // of the expression is literal text This is safe to do with UTF-8 text--
    // regex operators are all ASCII symbols, and ASCII symbols are always
    // single characters.  The substring to the left of a symbols must itself
    // also be a valid UTF-8 string.
    size_t literalExtent = 0;
    for (auto& ch : regexSource) {
        if (!string::isSymbol(ch))
            ++literalExtent;
        else
            break;
    }

    WordIdList matchingWordIds;
    if (literalExtent) {
        // If the expression contained leading literal text and then a symbol,
        // use the literal portion as a prefix
        if (literalExtent != regexSource.size()) {
            auto prefix = regexSource.substr(0, literalExtent);
            for (auto it = db.wordNoCaseIndex().lower_bound(prefix);
                 it != db.wordNoCaseIndex().end(); ++it) {
                auto word = db.lookupWord(it->first);
                if (word.startsWith(prefix, false)) {
                    // Found a word that has a matching prefix; evaluate the
                    // regex
                    if (std::regex_match(word.begin(), word.end(), regex))
                        matchingWordIds.push_back(it->second);
                } else
                    break;
            }
        }
        // Otherwise, find the exact word
        else
            matchingWordIds = db.lookupWordIds(regexSource);
    } else {
        // If there were no expressions that we could optimize, evaluate each
        // regex against every word in the DB
        for (auto& [wordId, proxy] : db.wordIdIndex()) {
            auto word = db.lookupWord(proxy);
            if (std::regex_match(word.begin(), word.end(), regex))
                matchingWordIds.push_back(wordId);
        }
    }

    // Find the ID's of all the documents that contain any of the words
    return selectDocsContainingAnyWordId(db, matchingWordIds);
}

inline DocIdSet selectDocs(const WordDbRead& db,
                           const search::CompiledOps& ops) noexcept(false) {
    using namespace engine::index::search;

    // Stack of sets of doc ID's
    std::stack<DocIdSet> docIdStack;
    auto popDocIds = [&]() noexcept(false) {
        if (docIdStack.empty())
            APERRL_THROW(Search, Ec::InvalidParam, "Malformed search", ops);

        auto docIds = _mv(docIdStack.top());
        docIdStack.pop();
        return docIds;
    };

    // Evaluate the operations
    for (auto& op : ops) {
        if (isIgnoredOpCode(op.opCode)) continue;

        DocIdSet docIds;
        switch (op.opCode) {
            case OpCode::In:
            case OpCode::Near:
            case OpCode::Phrase:
                docIds = selectDocsContainingAllWords(db, op.wordVariations);
                break;

            case OpCode::Any:
                docIds = selectDocsContainingAnyWordId(db, op.wordIds);
                break;

            case OpCode::Glob:
            case OpCode::Like:
                docIds = selectDocsContainingGlobMatch(db, op.glob);
                break;

            case OpCode::Regexp:
                docIds = selectDocsContainingRegexMatch(db, op.regex,
                                                        op.regexSource);
                break;

            case OpCode::And: {
                auto v1 = popDocIds();
                auto v2 = popDocIds();
                std::set_intersection(v1.begin(), v1.end(), v2.begin(),
                                      v2.end(),
                                      std::inserter(docIds, docIds.end()));
                break;
            }

            case OpCode::Or: {
                auto v1 = popDocIds();
                auto v2 = popDocIds();
                std::set_union(v1.begin(), v1.end(), v2.begin(), v2.end(),
                               std::inserter(docIds, docIds.end()));
                break;
            }

            case OpCode::Not: {
                // On negation, consider all the documents (do not optimize)
                // Rationale is simple:
                //      Consider 'not this phrase' content search.
                //      The first stage is to filter out all the documents which
                //      contain corresponding words. Among those documents,
                //      there are documents that contain the exact phrase, and
                //      also the documents that contain those words but in
                //      different order. If the resulting list of documents is
                //      reversed on this step, the documents that contain those
                //      words but in different order, would be excluded, and
                //      this is wrong. To avoid this, include all the documents
                //      on the negation step.
                // Everything would be filtered out, when a `search` is called
                popDocIds();
                std::transform(db.docIdIndex().begin(), db.docIdIndex().end(),
                               std::inserter(docIds, docIds.begin()),
                               [](const Pair<DocId, DocHash>& item) -> DocId {
                                   return item.first;
                               });

                break;
            }

            default:
                // Shouldn't be possible with compiled ops
                APERRL_THROW(Search, Ec::InvalidParam, "Invalid opcode",
                             _cast<int>(op.opCode));
                break;
        }

        docIdStack.emplace(_mv(docIds));
    };

    // Is this possible?
    if (docIdStack.empty()) {
        LOG(Search, "Nothing on stack after evaluating operations",
            _tsd<'\n'>(ops));
        return {};
    }

    auto docs = popDocIds();
    LOG(Search, "Selected {,c} docs for ops: {}", docs.size(), _tsd<'\n'>(ops));
    return docs;
}

inline constexpr bool doesOpEvaluationRequireDocWords(
    const search::CompiledOp& op) noexcept {
    switch (op.opCode) {
        // These ops are all evaluated by the indicated functions during
        // filtering
        case search::OpCode::In:      // Satisfied selectDocsContainingAllWords
        case search::OpCode::Any:     // Satisfied selectDocsContainingAnyWord
        case search::OpCode::Glob:    // Satisfied selectDocsContainingGlobMatch
        case search::OpCode::Like:    // Satisfied selectDocsContainingGlobMatch
        case search::OpCode::Regexp:  // Satisfied
                                      // selectDocsContainingRegexMatch
            return false;

        // Near and Phrase are the two ops that can't be evaluated during
        // filtering because they require loading the doc words (if the op has
        // multiple operands)
        case search::OpCode::Near:
        case search::OpCode::Phrase:
            return op.wordVariations.size() > 1;
    }
    return false;
}

}  // namespace engine::index
