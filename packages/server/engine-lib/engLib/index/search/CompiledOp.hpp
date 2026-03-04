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

// Compiled search operation
struct CompiledOp : Op {
public:
    _const auto LogLevel = Lvl::Search;

    CompiledOp(const WordDbRead& db, Op&& op) noexcept(false) : Op(_mv(op)) {
        // Validate word count
        switch (opCode) {
            case OpCode::In: {
                // Verify word count
                if (words.empty())
                    APERRT_THROW(Ec::InvalidParam,
                                 "Search operator missing required word(s)");

                // Build a set of unique words so we don't end up searching
                // multiple times on e.g. "cat CAT"
                std::set<iText> uniqueWords;
                _addTo(uniqueWords, words);

                // Build a list of lists of case variations; a word from each
                // list must exist in each document
                if (auto variations = lookupWordVariations(db, uniqueWords))
                    wordVariations = _mv(*variations);
                break;
            }

            case OpCode::Near:
            case OpCode::Phrase:
                // Verify word count
                if (words.empty())
                    APERRT_THROW(Ec::InvalidParam,
                                 "Search operator missing required word(s)");

                // Build a list of lists of case variations; a word from each
                // list must exist in each document
                if (auto variations = lookupWordVariations(db, words))
                    wordVariations = _mv(*variations);
                break;

            case OpCode::Any:
                // Verify word count
                if (words.empty())
                    APERRT_THROW(Ec::InvalidParam,
                                 "Search operator missing required word(s)");

                wordIds = lookupWordIds(db, words);
                break;

            case OpCode::Glob:
            case OpCode::Like:
            case OpCode::Regexp: {
                // Multiple words aren't supported for these
                if (words.size() != 1)
                    APERRT_THROW(
                        Ec::InvalidParam,
                        "Search operator has unexpected number of words",
                        words);

                // Compile the pattern
                auto& pattern = words[0];
                switch (opCode) {
                    case OpCode::Glob:
                        glob = *compileGlob(pattern);
                        break;

                    case OpCode::Like:
                        glob = *compileLikePattern(pattern);
                        break;

                    case OpCode::Regexp:
                        regex = *compileRegularExpression(pattern);
                        regexSource = pattern;
                        break;
                }
                break;
            }

            case OpCode::Load:
            case OpCode::And:
            case OpCode::Or:
            case OpCode::Not:
            case OpCode::Done:
                // Anything else shouldn't have words at all, but we can ignore
                // them
                if (!words.empty())
                    LOGT("Search operator has unexpected words", words);
                break;

            default:
                // Do not use APERRT_THROW here-- if the op code is invalid,
                // formatting of this object will itself fail
                APERRL_THROW(Search, Ec::InvalidParam,
                             "Unhandled search operator type",
                             _cast<int>(opCode));
                break;
        }
    }

    ~CompiledOp() = default;
    CompiledOp(const CompiledOp&) = default;
    CompiledOp(CompiledOp&&) = default;

    // In, Near, Phrase
    WordVariationList wordVariations;

    // Any
    WordIdSet wordIds;

    // Glob, Like
    globber::Glob glob;

    // Regexp
    std::regex regex;
    Text regexSource;

    // During compilation, set to true if child of a Not operator (match context
    // for anything inside a Not clause should not be returned to the user)
    bool contextDisabled = false;
};

// Alias a collection of CompiledOps
using CompiledOps = std::vector<CompiledOp>;

// Visit an operator and its children and apply callback
template <typename Callback>
inline void visit(CompiledOps& ops, size_t currentOpIndex,
                  Callback&& callback) noexcept {
    ASSERT(currentOpIndex < ops.size());
    auto& op = ops[currentOpIndex];

    // Apply callback to current operator
    callback(op);

    // Visit children, if any
    const size_t childCount = getOperandCount(op.opCode);
    ASSERT(currentOpIndex >= childCount);
    for (size_t i = 0, childIndex = currentOpIndex - 1; i < childCount;
         ++i, --childIndex) {
        visit(ops, childIndex, std::forward<Callback>(callback));
    }
}

inline CompiledOps compileOps(const WordDbRead& db, Ops&& ops) noexcept(false) {
    CompiledOps compiledOps;
    compiledOps.reserve(ops.size());
    size_t resultStackDepth = {};

    for (auto& op : ops) {
        // If it's LOAD or DONE, drop it
        if (isIgnoredOpCode(op.opCode)) continue;

        // Verify all terms are NFKC-normalized
        for (auto& word : op.words) {
            if (!string::icu::isNormalized(word))
                APERRL_THROW(Search, Ec::InvalidParam,
                             "Search term is not normalized", word, op);
        }

        // Compile the op
        CompiledOp compiledOp(db, _mv(op));

        // Verify the simulated result stack has enough results to satisfy any
        // logical operation
        const size_t operandCount = getOperandCount(compiledOp.opCode);
        if (resultStackDepth < operandCount)
            APERRL_THROW(Search, Ec::InvalidParam,
                         "Operator has too few operands on stack", compiledOp,
                         ops);

        // "Pop" the indicated number of results
        resultStackDepth -= operandCount;

        // "Push" a result (every non-ignored operator yields one result)
        ++resultStackDepth;

        // Add the compiled operator
        compiledOps.emplace_back(_mv(compiledOp));

        // If the op is a Not operator, mark all of its children as not able to
        // have context
        if (compiledOps.back().opCode == OpCode::Not) {
            visit(compiledOps, compiledOps.size() - 1,
                  [](CompiledOp& op) noexcept {
                      // Invert contextDisabled to cover the case of double Not
                      op.contextDisabled = !op.contextDisabled;
                  });
        }
    }

    // If the simulated result stack does not have a depth of 1, the search is
    // malformed
    if (resultStackDepth != 1)
        APERRL_THROW(Search, Ec::InvalidParam, "Search is malformed",
                     resultStackDepth, ops);

    return compiledOps;
}

}  // namespace engine::index::search
