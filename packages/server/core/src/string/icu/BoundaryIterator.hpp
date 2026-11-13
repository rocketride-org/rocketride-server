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

namespace ap::string::icu {

// BoundaryIterator abstracts the ICU rule based break iterator for iterating a
// non owned string view
template <typename RuleSet, typename ChrT, typename TraitsT = Case<ChrT>,
          size_t maxWordSize = 256, typename AllocT = std::allocator<ChrT>>
class BoundaryIterator {
public:
    _const auto LogLevel = Lvl::Icu;
    using StrType = Str<ChrT, TraitsT, AllocT>;
    using ViewType = StrView<ChrT, TraitsT>;
    _const auto IsWide = sizeof(ChrT) == sizeof(Utf16Chr);
    _const auto MaxWordSize = maxWordSize;

    BoundaryIterator(const AllocT &alloc = {}) noexcept(false)
        : m_word(alloc), m_iter(*allocate()) {}

    template <typename ChrTT = ChrT, typename TraitsTT = string::Case<ChrTT>>
    BoundaryIterator(StrView<ChrTT, TraitsTT> input,
                     const AllocT &alloc = {}) noexcept
        : m_word(alloc), m_iter(*allocate()) {
        setText(input);
    }

    template <typename ChrTT = ChrT, typename TraitsTT = string::Case<ChrTT>>
    void setText(StrView<ChrTT, TraitsTT> input,
                 const AllocT &alloc = {}) noexcept {
        LOGT("Parsing text:\n", input);
        m_text = _tr<UnicodeString>(input);
        m_iter->setText(m_text);
        m_buff = m_text.getBuffer();
        m_end = m_iter->next();
        m_start = {};
        m_word = StrType{alloc};
    }

    void first() noexcept { m_start = m_end = m_iter->first(); }

    void last() noexcept { m_start = m_end = m_iter->last(); }

    ViewType next() noexcept {
        for (auto &end = m_end, &start = m_start; end != BreakIterator::DONE;
             end = m_iter->next()) {
            if (end == BreakIterator::DONE) return {};

            // Assign start to end after we leave scope
            auto nextScope = util::Guard{[&] { start = end; }};

            // If this is nothing (meaning a skipped boundary) just move on
            if (m_iter->getRuleStatus() == RuleSet::STATUS_NONE) continue;

            // Pull out our parsed word as a view and read our arena bound
            // stack text for the conversion target
            auto wordWide = Utf16View{&m_buff[start], _nc<size_t>(end - start)};

            // Bail if its longer then requested
            if (wordWide.size() > MaxWordSize || !wordWide) continue;

            // Transform directly to our word member
            __transform(wordWide, m_word);
            LOGT("Parsed word: \"{}\" status: {} ({})", m_word,
                 RuleSet::renderStatus(m_iter->getRuleStatus()),
                 m_iter->getRuleStatus());

            // Increment the cursor for next time
            nextScope.exec();
            end = m_iter->next();
            return m_word;
        }

        return {};
    }

    ViewType previous() noexcept {
        for (auto &end = m_end, &start = m_start; start != BreakIterator::DONE;
             start = m_iter->previous()) {
            if (start == BreakIterator::DONE) return {};

            // Assign start to end after we leave scope
            auto nextScope = util::Guard{[&] { end = start; }};

            /*
             * The function getRuleStatus() returns an enum giving additional
             * information on the text preceding the last break position found.
             * Using this value, it is possible to distinguish between numbers,
             * words, words containing kana characters, words containing
             * ideographic characters, and non-word characters, such as spaces
             * or punctuation
             */
            // If this is nothing (meaning a skipped boundary) just move on
            if (m_iter->getRuleStatus() == RuleSet::STATUS_NONE) continue;

            // Increment the cursor to read current token
            nextScope.exec();
            start = m_iter->previous();

            // Pull out our parsed word as a view and read our arena bound
            // stack text for the conversion target
            auto wordWide = Utf16View{&m_buff[start], _nc<size_t>(end - start)};

            // Bail if its longer then requested
            if (wordWide.size() > MaxWordSize || !wordWide) continue;

            // Transform directly to our word member
            __transform(wordWide, m_word);
            LOGT("Parsed word: \"{}\" status: {} ({})", m_word,
                 RuleSet::renderStatus(m_iter->getRuleStatus()),
                 m_iter->getRuleStatus());

            return m_word;
        }

        return {};
    }

    template <typename ChrTT = ChrT, typename TraitsTT = TraitsT>
    static ErrorOr<std::vector<StrType>> parseWords(
        StrView<ChrTT, TraitsTT> data, const AllocT &alloc = {}) noexcept {
        return _call([&] {
            _thread_local async::Tls<BoundaryIterator> iter(_location);
            iter->setText(data, alloc);
            std::vector<StrType> results;
            while (auto word = iter->next()) results.emplace_back(word, alloc);
            return results;
        });
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "icu::BoundaryIterator";
    }

protected:
    static ErrorOr<BreakPtr> allocate() noexcept {
        // Create a word break iterator for the us utf8 locale
        UErrorCode ec = U_ZERO_ERROR;
        BreakPtr breakIter{
            BreakIterator::createWordInstance(Locale("en_US.UTF-8"), ec)};
        if (U_SUCCESS(ec)) {
            ASSERTD(breakIter);
            return breakIter;
        }

        return APERRL(Icu, Ec::Icu,
                      "Failed to create ICU break iterator:", u_errorName(ec));
    }

    BreakPtr m_iter;
    UnicodeString m_text;
    const char16_t *m_buff;
    StrType m_word;
    int m_start = {};
    int m_end = BreakIterator::DONE;
};

}  // namespace ap::string::icu
