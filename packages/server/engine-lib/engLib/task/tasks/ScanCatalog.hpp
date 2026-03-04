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

namespace engine::task::scan::catalog {
using namespace engine::store::scan;
using namespace engine::task;

//-------------------------------------------------------------------------
///	@details
///		Define the scan job controlling class
//-------------------------------------------------------------------------
class Task : public IPipeTask<Lvl::JobScan> {
    using Parent = IPipeTask<Lvl::JobScan>;
    using Path = ap::file::Path;
    using Parent::Parent;

private:
    class ScanCatalog : public Scanner {
    public:
        //-----------------------------------------------------------------
        /// @details
        ///		Declare our object handler
        //-----------------------------------------------------------------
        virtual Error addScanObject(ScanContext &context, Entry &object,
                                    const Path &objectPath) noexcept override;
        virtual Error flushContext(ScanContext &context) noexcept override;
        virtual Error flushTask() noexcept override;

        //-----------------------------------------------------------------
        // Private API
        //-----------------------------------------------------------------
        Url segmentPath() noexcept;
        Error packObject(const Entry &object, Text &line) noexcept;
        Error flushBatch() noexcept;
        Error writeBatchPath(ScanContext &context) noexcept;
        Error addBatch(ScanContext &context, Text &line) noexcept;

        //-----------------------------------------------------------------
        ///	@details
        ///		Our stream ptr
        //-----------------------------------------------------------------
        ErrorOr<StreamPtr> m_batchStream{};

        //-----------------------------------------------------------------
        ///	@details
        ///		This counter assigns a segment id to a stream, as streams are
        ///		created this gets incremented and becomes the segment id
        //-----------------------------------------------------------------
        uint32_t m_nextSegmentId = 0;

        //-----------------------------------------------------------------
        ///	@details
        ///		Overall count in the batch
        //-----------------------------------------------------------------
        CountSize m_batchCount{};

        //-----------------------------------------------------------------
        ///	@details
        ///		The output file specified
        //-----------------------------------------------------------------
        Url m_outputUrl;

        //-----------------------------------------------------------------
        ///	@details
        ///		The output type specified
        //-----------------------------------------------------------------
        Text m_outputType;

        //-----------------------------------------------------------------
        /// @details
        ///		This gives use the size and counts that each batch
        ///		we create should not exceeed (approx)
        //-----------------------------------------------------------------
        CountSize m_maxCounts = {.count = 250000, .size = MaxValue<Size>};
    };

public:
    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobScan;

    //-----------------------------------------------------------------
    /// @details
    ///		The name of this component
    //-----------------------------------------------------------------
    _const auto Type = "scanSources"_tv;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, IPipeTask>(Type);

    virtual Error exec() noexcept override;

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Declare our scanner
    //-----------------------------------------------------------------
    ScanCatalog m_scanner;
};
}  // namespace engine::task::scan::catalog
