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

//-----------------------------------------------------------------------------
//
//	Defines the splitter
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::indexer {
//-----------------------------------------------------------------
///	@details
///		Get the capacity of our buffer
//-----------------------------------------------------------------
size_t IFilterInstance::Tokenize::capacity() const noexcept {
    return UnicodeBufferChars - m_unicodeBufferLength;
}

//-----------------------------------------------------------------
/// @details
///		Parse the text
///	@param[in] text
///		Text to parse
///	@param[in] isFinal
///		Is this the final block we are going to recieve?
//-----------------------------------------------------------------
Error IFilterInstance::Tokenize::parseText(Utf16View text) noexcept {
    // Bail if nothing to do
    if (text.empty()) return {};

    // Use the stack for text conversion
    StackTextArena utf8Arena;
    StackText utf8{utf8Arena};
    std::vector<StackText> results;

    // Use the stack to store the last word in the buffer.
    // Use a new stack allocator because utf8Arena is UTF-8 and we don't want to
    // share a buffer with m_utf16Arena, which is dedicated to holding the
    // UTF-16 text.
    StackUtf16Arena lastWordArena;
    StackUtf16 lastWord{lastWordArena};

    auto flushScope = util::Guard{[&] { m_parent.addWords(results); }};

    // Allocate an iterator if we don't have one yet
    _thread_local async::Tls<Utf16TokenIter<>> tokenizer(_location);

    // Set the buffer to tokenize
    tokenizer->setText(text);

    // Tokenize the UTF-16 LE buffer
    while (auto word = tokenizer->next()) {
        // Unless this is our final pass, preserve the final word so we don't
        // add a truncated word on a parsing boundary
        if (tokenizer->done()) {
            lastWord = word;

            // Double-check that we're really done
            ASSERTD_MSG(!tokenizer->next(), "TokenIterator::done() lied!");
            break;
        } else {
            // Convert the UTF-16 LE text to UTf-8 and store
            __transform(word, utf8);
            results.emplace_back(_mv(utf8));
        }
    }

    // Make sure we flush what we've got
    flushScope.exec();

    // Double-check that we didn't miss a last word
    ASSERT_MSG(tokenizer->done(),
               "TokenIterator::next() returned an empty string before all text "
               "was tokenized");

    // Empty the buffer
    m_unicodeBufferLength = 0;

    // Store the last word at the front of the buffer so that it will be
    // reprocessed on the next pass
    if (!lastWord.empty()) {
        // Check if the word is both smaller than the max indexable word and
        // will fit in our buffer
        if (lastWord.length() <= tokenizer->MaxWordSize &&
            lastWord.length() < UnicodeBufferChars) {
            std::memcpy(m_unicodeBuffer, lastWord.c_str(),
                        lastWord.length() * sizeof(Utf16Chr));
            m_unicodeBufferLength = lastWord.length();
        } else
            LOGT(
                "Extracted text contained a large word that could not be "
                "indexed; discarding",
                lastWord);
    }
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This function will flush all the words out of the built up unicode
///		buffer and starts parsing it
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::Tokenize::flush() noexcept {
    // If the buffer is empty, done now
    if (!m_unicodeBufferLength) return {};

    // Record length of buffer before parsing
    auto lengthBeforeParse = m_unicodeBufferLength;

    // Parse it
    parseText(Utf16View{m_unicodeBuffer, m_unicodeBufferLength});

    // Record characters parsed (assume the buffer can never grow during a
    // parse)
    ASSERTD(m_unicodeBufferLength <= lengthBeforeParse);
    m_charsParsed += (lengthBeforeParse - m_unicodeBufferLength);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Puts text into the unicode buffer and, when full, flushes it which
///     causes the words to be tokenized and sent out to the target channel
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::Tokenize::processText(
    const Utf16View &textView) noexcept {
    // For each chr
    for (auto index = 0; index < textView.size(); index++) {
        // Fill up almost all the way
        if (capacity() < 16) flush();

        // Get the next chr
        Utf16Chr chr = textView[index];

        // If we have a pending hi surrogate
        if (m_highSurrogate) {
            // Grab it
            auto hi = m_highSurrogate;

            // And clear it
            m_highSurrogate = 0;

            // If the current one is not a low surrogate, skip bot
            if (!ap::string::unicode::utf16::isLowSurrogate(chr)) continue;

            // Update the number of characters we received
            m_charsExtracted++;

            // Save the high one
            m_unicodeBuffer[m_unicodeBufferLength++] = hi;

            // Save the low one
            m_unicodeBuffer[m_unicodeBufferLength++] = chr;
            continue;
        }

        // If this is a high surrogate, save it
        if (ap::string::unicode::utf16::isHighSurrogate(chr)) {
            m_highSurrogate = chr;
            continue;
        }

        // If this is a low surrogate, we didn't get the high, so skip it
        if (ap::string::unicode::utf16::isLowSurrogate(chr)) {
            continue;
        }

        // Update the number of characters we received
        m_charsExtracted++;

        // Save it
        m_unicodeBuffer[m_unicodeBufferLength++] = chr;
    }
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Notify the writeWords filters that we are going to start
///		delivering words. This will switch over to the
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::Tokenize::open(Entry &object) noexcept {
    // Reset our state
    m_unicodeBufferLength = 0;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Gather blocks of incoming text (essentially from Tika), splits
///		them into the largest chunk available (seperated by white space),
///		and performs a boundary analysis on them
///	@param[in] text
///		The text we parsed (usually from Tika)
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::Tokenize::writeText(const Utf16View &text) noexcept {
    return processText(text);
}

//-------------------------------------------------------------------------
/// @details
///		Notify the writeWords filters that we are going with the
///		current document
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::Tokenize::closing() noexcept {
    // Flush any remaining
    return flush();
}
}  // namespace engine::store::filter::indexer
