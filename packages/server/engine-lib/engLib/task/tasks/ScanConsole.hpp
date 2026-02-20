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

namespace engine::task::scan::console {
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
    class ScanConsole : public Scanner {
        //-----------------------------------------------------------------
        /// @details
        ///		Declare our object handler
        //-----------------------------------------------------------------
        virtual Error addScanObject(ScanContext &context, Entry &object,
                                    const Path &objectPath) noexcept override;
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
    _const auto Type = "scanConsole"_tv;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, IPipeTask>(Type);

    virtual Error beginTask() noexcept override;
    virtual Error exec() noexcept override;

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Declare our scanner
    //-----------------------------------------------------------------
    ScanConsole m_scanner;
};
}  // namespace engine::task::scan::console
