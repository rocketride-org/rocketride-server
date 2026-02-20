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

namespace engine::task::pipeline {
using namespace engine::store::scan;

//-------------------------------------------------------------------------
/// @details
///		Define what types of operations we support
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(PIPELINE_MODE, 0, 2, CATALOG = _begin, DIRECT);

//-------------------------------------------------------------------------
/// @details
///		The instance task runs the the pipeline to sign and index
///		the entries
//-------------------------------------------------------------------------
class Task : public IPipeTask<Lvl::JobPipeline> {
public:
    using Parent = IPipeTask<Lvl::JobPipeline>;
    using Parent::Parent;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare the scanner we will use to deliver objects directly
    ///     to the target
    //-----------------------------------------------------------------
    class ScanDirect : public Scanner {
    public:
        //-------------------------------------------------------------
        /// @details
        ///		Declare our object handler
        //-------------------------------------------------------------
        virtual Error addScanObject(ScanContext &context, Entry &object,
                                    const Path &objectPath) noexcept override;

        //-------------------------------------------------------------
        /// @details
        ///		Declare our object handler
        //-------------------------------------------------------------
        virtual Error setPipelineTask(Task *pTask) {
            m_pTask = pTask;
            m_directMode = true;
            return {};
        };

    private:
        //-------------------------------------------------------------
        /// @details
        ///		Pointer to the containing pipeline task
        //-------------------------------------------------------------
        Task *m_pTask = nullptr;
    };

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobPipeline;

    //-----------------------------------------------------------------
    /// @details
    ///		Define our factory info
    //-----------------------------------------------------------------
    _const auto Factory =
        Factory::makeFactory<Task, IPipeTask<Lvl::JobPipeline>>("pipeline");

    //-----------------------------------------------------------------
    /// @details
    ///		Our overrides
    //-----------------------------------------------------------------
    ErrorOr<Entry> processLine(TextView line,
                               const Url &parent) noexcept override;
    Error processItem(Entry &entry) noexcept override;

    Error beginTask() noexcept override;
    Error enumInput() noexcept override;
    Error endTask() noexcept override;
    Error exec() noexcept override;

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Declare our scanner
    //-----------------------------------------------------------------
    ScanDirect m_scanner;

    //-----------------------------------------------------------------
    /// @details
    ///		The mode of this pipeline
    //-----------------------------------------------------------------
    PIPELINE_MODE m_mode;
};
}  // namespace engine::task::pipeline
