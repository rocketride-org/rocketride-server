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

namespace engine::task::searchBatch {

// Have not done a lot of refactoring here as it was not necessary
// It does compiled and function correctly, but not necessarily
// optimized for the new engine model

//-------------------------------------------------------------------------
/// @details
///     Executes the search on the compile ops
/// @param[in]	ops
///		The compiled ops
//-------------------------------------------------------------------------
Error Task::search(const engine::index::search::CompiledOps& ops) noexcept {
    auto start = time::now();

    async::work::Group tasks;
    for (auto& docId : m_docs) {
        if (async::cancelled()) return async::cancelled(_location);

        // Stop if we know we've already exceeded the requested count
        if (m_objectCount >= m_searchOpts.objectLimit) break;

        // Spawn the task now it'll increment the object count when it finds
        // something
        auto task = async::work::submitRef(
            m_executor, _location, _ts("Search doc", docId),
            [this, docId, &ops] {
                // Abort early if object count has been exceeded
                if (m_objectCount >= m_searchOpts.objectLimit) return;

                LOGT("Searching doc: {}", docId);

                Error ccode;
                engine::index::search::QueryCtx ctx(m_wordDb, docId,
                                                    m_searchOpts);
                if (engine::index::searchWords(ctx, ops, ccode)) {
                    if (auto docHash = m_wordDb.lookupDocHash(docId)) {
                        json::Value match;
                        match["docHash"] = _ts(docHash);
                        if (ctx.contexts())
                            match["context"] = _mv(ctx.contexts());
                        MONITOR(info, match);

                        // Now we can increment this, we logged the info
                        m_objectCount++;
                    } else
                        MONERR(error, Ec::Unexpected,
                               "Failed to lookup doc hash from ID", docId);
                } else if (ccode)
                    MONERR(warning, ccode,
                           "Failed to perform search for document", docId);
            });

        if (!task) {
            m_executor.deinit();
            return APERRT(task.ccode(), "Failed to spawn task");
        }
        tasks << _mv(*task);
    }

    LOGT("Waiting on {,c} tasks", tasks.size());

    while (tasks.executing()) {
        async::yield();
        if (async::cancelled()) {
            m_executor.deinit();
            return async::cancelled(_location);
        }
    }
    if (auto ccode = tasks.join()) return ccode;

    LOGT("Search completed in {} with {,c} results", time::now() - start,
         m_objectCount);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///     Execute the search task
//-------------------------------------------------------------------------
Error Task::exec() noexcept {
    // Setup the parameters
    if (auto ccode = taskConfig().lookupAssign("threadCount", m_threadCount) ||
                     taskConfig().lookupAssign("indexInput", m_indexInput) ||
                     taskConfig().lookupAssign("opCodes", m_opCodes) ||
                     _fja(taskConfig(), m_searchOpts))
        return ccode;

    // Check them
    if (!m_indexInput)
        return APERR(Ec::InvalidJson, "Missing required key indexInput");
    if (m_threadCount == 0) m_threadCount = 1;
    if (m_opCodes.empty()) return APERR(Ec::InvalidJson, "Empty opCodes");

    // Setup the work queue
    if (auto ccode = m_executor.init(m_threadCount, MaxValue<size_t>))
        return MONERR(error, ccode, "Failed to initialize", m_threadCount,
                      "search thread(s)");

    // Open it up
    auto start = time::now();
    LOGT("Opening word db", m_indexInput);

    // Open the word stream
    auto wordDbStream = stream::openStream(m_indexInput, stream::Mode::READ);
    if (!wordDbStream)
        return MONERR(error, wordDbStream.ccode(),
                      "Failed to open word database stream");

    // Open the word db
    if (auto ccode = m_wordDb.open(_mv(*wordDbStream)))
        return MONERR(error, ccode, "Failed to open word database");

    LOGT("Successfully opened word db in", time::now() - start);

    // Validate and compile the ops
    LOGT("Selecting documents to search");
    auto ops = _call([&] {
        return engine::index::search::compileOps(m_wordDb, _mv(m_opCodes));
    });
    if (!ops) return ops.ccode();

    // Select only the docs containing the words
    auto docs =
        _call([&] { return engine::index::selectDocs(m_wordDb, *ops); });
    if (!docs) return docs.ccode();

    m_docs = _mv(docs);
    if (m_docs.empty()) {
        LOGT("No docs selected");
        return {};
    }

    // Note that we're searching a filtered set of documents (enables
    // optimizations)
    m_searchOpts.documentsFiltered = true;

    LOGT("Performing search on {,c} selected docs", m_docs.size());
    if (auto ccode = search(*ops)) {
        if (ccode != Ec::Cancelled)
            return MONERR(error, ccode, "Search tasks reported failure");
        return ccode;
    }

    LOGT("Search completed in {}", time::now() - start);
    return {};
}
}  // namespace engine::task::searchBatch
