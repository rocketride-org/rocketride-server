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

#include <engLib/eng.h>

namespace engine::store::filter::indexer {
//-------------------------------------------------------------------------
/// @details
///		Begin the instance
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::beginFilterInstance() noexcept {
    LOGPIPE();

    // Call our parent first
    if (auto ccode = Parent::beginFilterInstance()) return ccode;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Notify the writeWords filters that we are going to start
///		delivering words. This will switch over to the
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::open(Entry &entry) noexcept {
    LOGPIPE();

    // Call the parent first
    if (auto ccode = Parent::open(entry)) return ccode;

    // If we are already indexed, we don't need to do this
    if (!(currentEntry->flags() & Entry::FLAGS::INDEX) &&
        currentEntry->wordBatchId())
        return {};

    // Tell the tokenize we are starting a new object
    if (auto ccode = m_tokenizer.open(entry)) return ccode;

    // Reset these
    m_wordIds = {};

#ifdef CHUNKED_DOC_STRUCT
    m_wordIds.reserve(m_docWordsCount);
    m_docStructChunked = false;
    m_fullDocWordsCount = 0;
    m_buffer.clear();
#endif

    m_metadata = {};

    // Clear the word batch id. We are indexing it and, if we get an
    // error in the indexing, then end will not be called...
    currentEntry->wordBatchId(0);

    // Put a shared lock saying we are running against this
    // word db. If it needs to flush at some point, it can do
    // this after we release our shared lock. Any ->lock has
    // priority over a ->sharedLock so when the writer will get an
    // exclusive lock, we will end up waiting until it is done
    m_sharedLock = global.sharedLock();
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
Error IFilterInstance::writeText(const Utf16View &text) noexcept {
    LOGPIPE();

    // If we are already indexed, we don't need to do this
    if (!(currentEntry->flags() & Entry::FLAGS::INDEX) &&
        currentEntry->wordBatchId()) {
        // Call the parent
        return Parent::writeText(text);
    }

    // Let the tokenize split it up
    if (auto ccode = m_tokenizer.writeText(text)) return ccode;

    // Forward it on
    return Parent::writeText(text);
}

//-------------------------------------------------------------------------
/// @details
///		Notify the writeWords filters that we are going done with the
///		current document
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::closing() noexcept {
    LOGPIPE();

    // If we are already indexed, we don't need to do this
    if (!(currentEntry->flags() & Entry::FLAGS::INDEX) &&
        currentEntry->wordBatchId()) {
        // Call the parent
        return Parent::closing();
    }

    // Tell the tokenizer we are done, flush everything
    if (auto ccode = m_tokenizer.closing()) return ccode;

    // Finalize this entry
    auto ccode = finalize();

    // Get the batchId
    auto batchId = global.currentBatchId();

    // Set it
    currentEntry->wordBatchId(batchId);

    // If we have a shared lock up, release it
    m_sharedLock = {};

    // Reset these
    m_wordIds = {};  // actually we don`t release memory by default init here

#ifdef CHUNKED_DOC_STRUCT
    m_docStructChunked = false;
    m_fullDocWordsCount = 0;
    m_buffer.clear();
#endif

    m_metadata = {};

    // Check for a switch in the wordDb due to this
    // one being full
    if (auto ccode = global.checkSwitchToNextBatch()) return ccode;

    // Call the parent
    return Parent::closing();
}

//-----------------------------------------------------------------------------
/// @details
///		This function will determine which format the source is in according
///		to the config and either forward it on if it is not rocketride format,
///		or read the segments parse them and send them to the the target
///	@param[in]	target
///		the output channel
///	@param[in]	object
///		object information
///	@returns
///		Error
//-----------------------------------------------------------------------------
Error IFilterInstance::renderObject(ServicePipe &target,
                                    Entry &object) noexcept {
    LOGPIPE();

    // Check if it is already failed
    if (object.objectFailed()) return {};

    // If we are not forcing it to go to the source, and
    // we have a word batch id, enumerate from the wordDB
    if (endpoint->config.openMode != OPEN_MODE::SOURCE_INDEX &&
        object.wordBatchId && object.wordBatchId()) {
        // Get the built in IO buffer
        IOBuffer *pIOBuffer;
        if (auto ccode = getIOBuffer(&pIOBuffer)) return ccode;

        // Get it as utf16 character buffer
        Utf16Chr *pDataBuffer = (Utf16Chr *)pIOBuffer->data;

        // Get the length of characters in the buffer
        const auto maxLength = endpoint->config.segmentSize / sizeof(Utf16Chr);

        // And the number of chrs currently in the buffer
        uint64_t dataSize = 0;

        // Get it
        const auto dbRef = global.getWordBatch(object.wordBatchId());
        if (!dbRef) {
            object.completionCode(dbRef.ccode());
            return {};
        }

        auto releaseWordDbFcn = localfcn { global.releaseWordDb(); };
        util::Guard releaseWordDb{_mv(releaseWordDbFcn)};

        // Get the reference
        auto &db = dbRef->get();

        // Get the document id
        auto docId = db.lookupDocId(object.componentId.hash());

        // If we don't have it, pass it someone who may
        if (!docId) return pDown->renderObject(target, object);

        // Document hash is registered but has no indexed words (e.g. images)
        if (!db.hasDocId(docId)) return {};

        // The word buffer convertted to utf16
        Utf16 utf16;

        // Start walking the document list
        for (auto wordId : db.lookupDocWordIdList(docId)) {
            // If thread or process was cancelled let's finish immediately
            if (auto ccode = ap::async::cancelled(_location)) {
                return ccode;
            }

            // Stop at the first reserved word (i.e. metadata boundary)
            if (index::db::isReservedWordId(wordId)) break;

            // Lookup the word
            auto word = db.lookupWord(wordId);

            // And write it if this would overflow
            if (dataSize + (word.length() * 2) > maxLength) {
                // Get a view of it
                auto data = Utf16{pDataBuffer, dataSize};

                // Write the text
                if (auto ccode = pDown->sendText(target, data)) return ccode;

                // Clear it again
                dataSize = 0;
            }

            // Ensure we clear the destination, always
            utf16.clear();

            // And convert
            utf8::unchecked::utf8to16(word.begin(), word.end(),
                                      std::back_inserter(utf16));

            // Directly copy it
            memcpy(&pDataBuffer[dataSize], utf16.ptr(),
                   utf16.length() * sizeof(Utf16Chr));

            // Adjust the size
            dataSize += utf16.length();
        }

        // Flush any remaining
        if (dataSize) {
            // Get a view of it
            auto data = Utf16{pDataBuffer, dataSize};

            // Write the text
            if (auto ccode = pDown->sendText(target, data)) return ccode;
        }

        // We rendered it
        return {};
    }  // namespace engine::store::filter::indexer
    else {
        // Push it down the stack, we haven't got it or we
        // are being force to go to the source
        return pDown->renderObject(target, object);
    }
}

//-------------------------------------------------------------------------
/// @details
///		Notify the writeWords filters that we are going to start
///		delivering words. This will switch over to the
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::endFilterInstance() noexcept {
    // If we own it, clear it
    m_sharedLock = {};

    // Call our parent first
    if (auto ccode = Parent::endFilterInstance()) return ccode;
    return {};
}
}  // namespace engine::store::filter::indexer
