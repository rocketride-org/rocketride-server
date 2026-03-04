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

namespace engine::task::searchBatch {
//-------------------------------------------------------------------------
/// @details
///		Defines the tokenize task which takes a series of words or
///		phrases and tokenizes them for preparing the queryPlan
//-------------------------------------------------------------------------
class Task : public ITask {
public:
    using Parent = ITask;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our log level
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobSearchBatch;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, ITask>("searchBatch");

protected:
    //-----------------------------------------------------------------
    ///	@details
    ///		Execute the task - send results over the >INFO channel
    //-----------------------------------------------------------------
    Error exec() noexcept override;

private:
    //-----------------------------------------------------------------
    // Private API
    //-----------------------------------------------------------------
    Error search(const engine::index::search::CompiledOps &ops) noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		Atomic counter incremented by each spawned search batch
    ///		task to limit the result count
    //-----------------------------------------------------------------
    Atomic<size_t> m_objectCount = {};

    //-----------------------------------------------------------------
    ///	@details
    ///		Docs selected by the op code tokens
    //-----------------------------------------------------------------
    engine::index::DocIdSet m_docs;

    //-----------------------------------------------------------------
    ///	@details
    ///		The word db we are using
    //-----------------------------------------------------------------
    engine::index::WordDbRead m_wordDb;

    //-----------------------------------------------------------------
    ///	@details
    ///		The thread pool to use to find
    //-----------------------------------------------------------------
    async::work::Executor m_executor{"Search batch threads"};

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our index to use
    //-----------------------------------------------------------------
    Url m_indexInput;

    //-----------------------------------------------------------------
    ///	@details
    ///		The engine opcodes expressing the search
    //-----------------------------------------------------------------
    engine::index::search::Ops m_opCodes;

    //-----------------------------------------------------------------
    ///	@details
    ///		Options for the search
    //-----------------------------------------------------------------
    engine::index::search::Options m_searchOpts;

    //-----------------------------------------------------------------
    ///	@details
    ///		Thread count to use for the search
    //-----------------------------------------------------------------
    uint32_t m_threadCount = 5;
};

}  // namespace engine::task::searchBatch
