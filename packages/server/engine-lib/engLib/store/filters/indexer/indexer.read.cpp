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
///		Returns the opened word db for the given batch
///	@param[in] batchId
///		The batch id to get
//-------------------------------------------------------------------------
ErrorOr<CRef<WordDbRead>> IFilterGlobal::getWordBatch(
    uint64_t batchId) noexcept {
    std::unique_lock lock{m_wordDbLock};

    // Check if we want to get the currently open word db,
    // else let's see if we can open it or we need to wait
    // until all readers finish with the current word db
    if (m_currentWordDbId != batchId) {
        if (m_currentWordDbReaders > 0) {
            LOGL(Lvl::WordDb, _location,
                 "Waiting for current batch id to finish:", m_currentWordDbId);

            auto errCode = m_wordDbCondition.wait(
                lock, localfcn() noexcept {
                    return m_currentWordDbReaders == 0 ||
                           m_currentWordDbId == batchId;
                });

            if (errCode)
                return APERRL(Always, errCode,
                              "Error while trying to wait on current word db");
        }

        // Check if another thread already opened the word db
        // else open it
        if (m_currentWordDbId != batchId)
            if (auto ccode = updateCurrentWordDb(batchId)) return ccode;
    }

    if (!m_currentWordDb)
        return APERRL(Always, Ec::Empty, "Current WordDb is empty");

    ++m_currentWordDbReaders;

    return *m_currentWordDb;
}

//-------------------------------------------------------------------------
/// @details
///		Opens the specified word db and sets it as the current WordDb
///	@param[in] batchId
///		The batch id to open
//-------------------------------------------------------------------------
Error IFilterGlobal::updateCurrentWordDb(uint64_t batchId) noexcept {
    auto iter = m_batches.find(batchId);

    // If not found, error out
    if (iter == m_batches.end())
        return APERRL(Always, Ec::NotFound, "Batch {,x} not found", batchId);

    if (m_currentWordDbId != 0)
        LOGL(Lvl::WordDb, _location,
             "Closing WordDB with id:", m_currentWordDbId);

    m_currentWordDb = std::make_unique<WordDbRead>();

    auto start = time::now();

    if (auto ccode = m_currentWordDb->open(iter->second))
        return MONCCODE(error, ccode);

    LOGTT(Perf, "Successfully opened word db:", iter->second, "in",
          time::now() - start);

    m_currentWordDbId = batchId;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Decreases the amount of readers of the currently open WordDb, also
///     notifies when there are no more readers
//-------------------------------------------------------------------------
void IFilterGlobal::releaseWordDb() noexcept {
    std::unique_lock lock{m_wordDbLock};

    if (m_currentWordDbReaders > 0) {
        --m_currentWordDbReaders;
    }

    if (m_currentWordDbReaders == 0) {
        m_wordDbCondition.notifyAll(lock);
    }
}

}  // namespace engine::store::filter::indexer
