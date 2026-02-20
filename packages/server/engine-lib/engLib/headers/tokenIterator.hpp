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

namespace engine {
//-------------------------------------------------------------------------
/// @details
///		Mode for handling symbols and whitespace
//-------------------------------------------------------------------------
enum class SymbolAndWhitespaceMode { STRIP, KEEP };

//-------------------------------------------------------------------------
/// @details
///		State of whitespace collapsing while tokenizing
//-------------------------------------------------------------------------
enum class CollapsingWhitespaceMode {
    NONE,
    HORIZONTAL,
    VERTICAL,
};

//-------------------------------------------------------------------------
/// @details
///		TokenIterator uses the ICU rule-based break iterator to iterate
///		over word boundaries while returning all other symbols found
///		outside those words as tokens (including whitespace, which is
///		collapsed to a single token)
//-------------------------------------------------------------------------
template <
    typename RuleSet, typename ChrT, typename TraitsT = string::Case<ChrT>,
    size_t maxWordSize = MaxWordSize, typename AllocT = std::allocator<ChrT>>
class TokenIterator
    : public string::icu::BoundaryIterator<RuleSet, ChrT, TraitsT, maxWordSize,
                                           AllocT> {
public:
    using Parent = string::icu::BoundaryIterator<RuleSet, ChrT, TraitsT,
                                                 maxWordSize, AllocT>;
    using StrType = string::Str<ChrT, TraitsT, AllocT>;
    using ViewType = string::StrView<ChrT, TraitsT>;
    using ThisType = TokenIterator<RuleSet, ChrT, TraitsT, maxWordSize, AllocT>;

    //-----------------------------------------------------------------
    /// Constructor
    //-----------------------------------------------------------------
    TokenIterator(const AllocT &alloc = {}) noexcept(false) : Parent(alloc) {}

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the text to operate on
    ///	@param[in] input
    ///		The input text. Usually, this will be Utf16
    ///	@param[in] mode
    ///		The white space mode, defaults to KEEP
    ///	@param[in] alloc
    ///		Allocator used to allocate memory
    //-----------------------------------------------------------------
    template <typename ChrTT = ChrT, typename TraitsTT = string::Case<ChrTT>>
    void setText(string::StrView<ChrTT, TraitsTT> input,
                 SymbolAndWhitespaceMode mode = SymbolAndWhitespaceMode::KEEP,
                 const AllocT &alloc = {}) noexcept {
        // Setup
        m_stripSymbolsMode = mode;
        m_collapsingWhitespaceMode = CollapsingWhitespaceMode::NONE;
        m_subtokens.clear();
        m_lastLongWordDiscarded = {};

        // And call the parent
        return Parent::setText(input, alloc);
    }

    ViewType nextToken() noexcept { return Parent::next(); }

    ViewType prevToken() noexcept { return Parent::previous(); }

    //-----------------------------------------------------------------
    ///	@details
    ///		Gets the next token. Peforms a lot of processing on the
    ///		token to skip over?collapse white space, etc
    //-----------------------------------------------------------------
    ViewType next() noexcept {
        // Do we have remaining subtokens from the previous iteration?
        if (!m_subtokens.empty()) {
            if (m_subtokenIndex < m_subtokens.size())
                return m_subtokens[m_subtokenIndex++];
            else
                m_subtokens.clear();
        }

        // Find the next token, we may loop since we skip tokens
        // during collapsing
        for (auto &end = Parent::m_end, &start = m_start;
             end != string::icu::BreakIterator::DONE; end = m_iter->next()) {
            if (end == string::icu::BreakIterator::DONE) return {};

            // Assign start to end after we leave scope
            auto nextScope = util::Guard{[&] { start = end; }};

            // The tokenized word or break
            const Utf16View sequence{&m_buff[start],
                                     _cast<size_t>(end - start)};

            // If we found a break, test whether it's whitespace or a symbol
            if (m_iter->getRuleStatus() == RuleSet::STATUS_NONE) {
                // First (and probably only) UTF-16 character
                const char16_t utf16Ch = sequence.front();

                // If the break contained multiple characters, it should either
                // be a UTF-16 surrogate pair or a sequence of whitespace, e.g.
                // "\r\n"
                if (sequence.length() > 1 &&
                    !string::unicode::isHighSurrogate(utf16Ch) &&
                    !string::isSpace(sequence)) {
                    // This means the break is invalid, which shouldn't be
                    // possible; log the problem and discard the break
                    LOGT(
                        "Found an unexpected multiple-character break: {} ({} "
                        "bytes)",
                        sequence, sequence.length());
                    continue;
                }

                // Is this horizontal whitespace?
                if (string::isHorizontalSpace(utf16Ch)) {
                    // Was this whitespace preceded by any whitespace?  If so,
                    // collapse it, i.e. ignore it
                    if (m_collapsingWhitespaceMode !=
                        CollapsingWhitespaceMode::NONE)
                        continue;

                    // Otherwise, normalize the horizontal whitespace by
                    // appending a space and note that any further whitespace
                    // should be collapsed
                    m_collapsingWhitespaceMode =
                        CollapsingWhitespaceMode::HORIZONTAL;
                    if (keepSymbolsAndWhitespace()) {
                        _const ChrT spaceChar = ' ';
                        m_word = ViewType{&spaceChar, 1};
                        LOGT(
                            "Parsed horizontal whitespace: ' ' status: {} ({})",
                            RuleSet::renderStatus(m_iter->getRuleStatus()),
                            m_iter->getRuleStatus());
                    } else
                        continue;
                }
                // Is this vertical whitespace?
                else if (string::isVerticalSpace(utf16Ch)) {
                    // Was this whitespace preceded by only vertical whitespace?
                    // If so, collapse it, i.e. ignore it
                    if (m_collapsingWhitespaceMode ==
                        CollapsingWhitespaceMode::VERTICAL)
                        continue;

                    // Otherwise, normalize the vertical whitespace by appending
                    // a linefeed and note that any further whitespace should be
                    // collapsed
                    m_collapsingWhitespaceMode =
                        CollapsingWhitespaceMode::VERTICAL;
                    if (keepSymbolsAndWhitespace()) {
                        _const ChrT linefeedChar = '\n';
                        m_word = ViewType{&linefeedChar, 1};
                        LOGT("Parsed vertical whitespace: ' ' status: {} ({})",
                             RuleSet::renderStatus(m_iter->getRuleStatus()),
                             m_iter->getRuleStatus());
                    } else
                        continue;
                }
                // Is this a symbol? It may be either a UTF-16 surrogate pair
                // symbol, an ASCII symbol, or a UTF-16 symbol
                else if ((sequence.length() == 2 &&
                          string::unicode::isHighSurrogate(utf16Ch)) ||
                         string::isSymbol(utf16Ch) ||
                         !string::isAscii(utf16Ch)) {
                    // Convert the UTF16 symbol to UTF8 (if needed)
                    if constexpr (traits::IsSameTypeV<ChrT, Utf16Chr>)
                        m_word = sequence;
                    else
                        __transform(sequence, m_word);

                    // Note not to collapse any subsequent whitespace
                    m_collapsingWhitespaceMode = CollapsingWhitespaceMode::NONE;

                    if (stripSymbolsAndWhitespace()) {
                        LOGT("Skipped symbol: '{}' status: {} ({})", m_word,
                             RuleSet::renderStatus(m_iter->getRuleStatus()),
                             m_iter->getRuleStatus());
                        continue;
                    } else
                        LOGT("Parsed symbol: '{}' status: {} ({})", m_word,
                             RuleSet::renderStatus(m_iter->getRuleStatus()),
                             m_iter->getRuleStatus());
                }
                // This should be a non-printable ASCII control character-- log
                // the problem and discard the break
                else {
                    LOGT(
                        "Found a single ASCII character break that was neither "
                        "whitespace nor a symbol: {}",
                        utf16Ch);
                    continue;
                }

                // Increment the cursor for next time and return the token
                nextScope.exec();
                end = m_iter->next();
                return m_word;
            } else
                m_collapsingWhitespaceMode = CollapsingWhitespaceMode::NONE;

            // Pull out our parsed word as a view and read our arena bound
            // stack text for the conversion target
            auto wordWide = sequence;
            if (!wordWide) continue;

            // Bail if its longer then requested
            if (wordWide.size() > maxWordSize) {
                LOGT("Discarded long word:", wordWide);
                m_lastLongWordDiscarded = wordWide;
                continue;
            }

            // If the first character of the word is numeric, strip all infix
            // numeric characters (see
            // http://www.unicode.org/reports/tr14/tr14-43.html#IS) except '.'.
            // If any non-numeric, non-infix characters are found, then the word
            // is of the form "123bob"; split it. These character tests must be
            // performed against the original UTF-16.
            if (string::isNumeric(wordWide.front())) {
                StackUtf16Arena arena;
                StackUtf16 stripped{arena};
                stripped.reserve(wordWide.size());
                auto wwIt = wordWide.begin();
                for (; wwIt != wordWide.end(); ++wwIt) {
                    if (string::isNumeric(*wwIt) || *wwIt == '.')
                        stripped += *wwIt;
                    else if (string::isUtfInfixNumeric(*wwIt))
                        continue;
                    else
                        break;
                }

                // Transform directly to our word member (if needed)
                if constexpr (traits::IsSameTypeV<ChrT, Utf16Chr>)
                    m_word = stripped;
                else
                    __transform(stripped, m_word);

                // Did we stop early because we found non-infix, i.e.
                // alphabetic, characters?
                if (wwIt != wordWide.end()) {
                    // Tokenize the remaining UTF-16 characters
                    // Use a new tokenizer for this so that the sequence won't
                    // be treated as numeric
                    auto remaining = wordWide.substr(wwIt - wordWide.begin(),
                                                     wordWide.end() - wwIt);
                    auto subtokens =
                        parseWords(remaining, keepSymbolsAndWhitespace(),
                                   m_word.get_allocator());
                    if (subtokens) {
                        m_subtokens = _mv(subtokens);
                        m_subtokenIndex = 0;
                    } else
                        LOGT(
                            "Failed to parse non-numeric string '{}' which "
                            "followed numeric sequence '{}': {}",
                            remaining, m_word, subtokens);
                }
            } else {
                // Transform directly to our word member
                __transform(wordWide, m_word);
            }

            LOGT("Parsed word: \"{}\" status: {}", m_word,
                 RuleSet::renderStatus(m_iter->getRuleStatus()));

            // Increment the cursor for next time
            nextScope.exec();
            end = m_iter->next();
            return m_word;
        }

        return {};
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Returns whether we are done or not with the current
    ///		input buffer
    //-----------------------------------------------------------------
    bool done() const noexcept {
        return m_subtokens.empty() && m_end == string::icu::BreakIterator::DONE;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Are we stripping symbols and whitespace?
    //-----------------------------------------------------------------
    bool stripSymbolsAndWhitespace() const noexcept {
        return m_stripSymbolsMode == SymbolAndWhitespaceMode::STRIP;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Are we keeping symbols and whitespace?
    //-----------------------------------------------------------------
    bool keepSymbolsAndWhitespace() const noexcept {
        return m_stripSymbolsMode == SymbolAndWhitespaceMode::KEEP;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Return the count of words that we too long that we
    ///		have discarded
    //-----------------------------------------------------------------
    Utf16View lastLongWordDiscarded() const noexcept {
        return m_lastLongWordDiscarded;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Standalone, static word parser. Uses a thread local storage
    ///		variable to hold a boundary parser since they are expensive
    ///		to allocate
    ///	@param[in] input
    ///		The input text. Usually, this will be Utf16
    ///	@param[in] keepSymbolsAndWhitespace
    ///		Set to true to keep symbols and whitespace
    ///	@param[in] alloc
    ///		Allocator used to allocate memory
    //-----------------------------------------------------------------
    template <typename ChrTT = ChrT, typename TraitsTT = TraitsT>
    static ErrorOr<std::vector<StrType>> parseWords(
        string::StrView<ChrTT, TraitsTT> input,
        bool keepSymbolsAndWhitespace = true,
        const AllocT &alloc = {}) noexcept {
        return _call([&] {
            _thread_local async::Tls<ThisType> iter(_location);
            iter->setText(input,
                          keepSymbolsAndWhitespace
                              ? SymbolAndWhitespaceMode::KEEP
                              : SymbolAndWhitespaceMode::STRIP,
                          alloc);
            std::vector<StrType> results;
            while (auto word = iter->next()) results.emplace_back(word, alloc);
            return results;
        });
    }

protected:
    //-----------------------------------------------------------------
    // Required to access parent class' protected members
    //-----------------------------------------------------------------
    using Parent::m_buff;
    using Parent::m_end;
    using Parent::m_iter;
    using Parent::m_start;
    using Parent::m_word;

protected:
    //-----------------------------------------------------------------
    ///	@details
    ///		The current strip mode
    //-----------------------------------------------------------------
    SymbolAndWhitespaceMode m_stripSymbolsMode = SymbolAndWhitespaceMode::KEEP;

    //-----------------------------------------------------------------
    ///	@details
    ///		Start on collapsing
    //-----------------------------------------------------------------
    CollapsingWhitespaceMode m_collapsingWhitespaceMode =
        CollapsingWhitespaceMode::NONE;

    //-----------------------------------------------------------------
    ///	@details
    ///		Subtokens we need to save to examine on the next call to
    ///		next
    //-----------------------------------------------------------------
    std::vector<StrType> m_subtokens;

    //-----------------------------------------------------------------
    ///	@details
    ///		The current position in the subtoken vector
    //-----------------------------------------------------------------
    size_t m_subtokenIndex = {};

    //-----------------------------------------------------------------
    ///	@details
    ///		Statistics on use throwing away
    //-----------------------------------------------------------------
    Utf16View m_lastLongWordDiscarded;
};

//-------------------------------------------------------------------------
/// @details
///		Define common tokenizers
//-------------------------------------------------------------------------
template <typename RuleSet = string::icu::BaseRules,
          typename Allocator = std::allocator<Utf8Chr>>
using TextTokenIter =
    engine::TokenIterator<RuleSet, Utf8Chr, string::Case<Utf8Chr>, MaxWordSize,
                          Allocator>;

template <typename RuleSet = string::icu::BaseRules,
          typename Allocator = std::allocator<Utf8Chr>>
using iTextTokenIter =
    engine::TokenIterator<RuleSet, Utf8Chr, string::NoCase<Utf8Chr>,
                          MaxWordSize, Allocator>;

template <typename RuleSet = string::icu::BaseRules,
          typename Allocator = std::allocator<Utf16Chr>>
using Utf16TokenIter =
    engine::TokenIterator<RuleSet, Utf16Chr, string::Case<Utf16Chr>,
                          MaxWordSize, Allocator>;

template <typename RuleSet = string::icu::BaseRules,
          typename Allocator = std::allocator<Utf16Chr>>
using iUtf16TokenIter =
    engine::TokenIterator<RuleSet, Utf16Chr, string::NoCase<Utf16Chr>,
                          MaxWordSize, Allocator>;

template <typename RuleSet = string::icu::BaseRules,
          typename Allocator = std::allocator<Utf32Chr>>
using Utf32TokenIter =
    engine::TokenIterator<RuleSet, Utf32Chr, string::Case<Utf32Chr>,
                          MaxWordSize, Allocator>;

template <typename RuleSet = string::icu::BaseRules,
          typename Allocator = std::allocator<Utf32Chr>>
using iUtf32TokenIter =
    engine::TokenIterator<RuleSet, Utf32Chr, string::NoCase<Utf32Chr>,
                          MaxWordSize, Allocator>;

}  // namespace engine
