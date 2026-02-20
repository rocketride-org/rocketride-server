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

namespace engine::task::permissions {
//-------------------------------------------------------------------------
/// @details
///		The permissions task runs the the pipeline to get permissions of
///		the entries
//-------------------------------------------------------------------------
class Task : public IPipeTask<Lvl::JobPermissions> {
public:
    using Parent = IPipeTask<Lvl::JobPermissions>;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobPermissions;

    //-----------------------------------------------------------------
    /// @details
    ///		Define our factory info
    //-----------------------------------------------------------------
    _const auto Factory =
        Factory::makeFactory<Task, IPipeTask<Lvl::JobPermissions>>(
            "permissions");

    //-----------------------------------------------------------------
    /// @details
    ///		Setup the operation
    //-----------------------------------------------------------------
    Error beginTask() noexcept override;

    //-----------------------------------------------------------------
    /// @details
    ///		Get number of processing threads
    /// @param[in] currentThreadCount
    ///     The current thread count
    /// @return
    ///		The number of threads to use for processing the entries
    //-----------------------------------------------------------------
    virtual uint32_t getThreadCount(
        uint32_t currentThreadCount) const noexcept override;

    //-----------------------------------------------------------------
    ///	@details
    ///		Calls the default line processing to create an entry
    ///		and queue it up
    /// @param[in] line
    ///		The incoming line - json format
    /// @param[in] parent
    ///		The current parent
    //-----------------------------------------------------------------
    ErrorOr<Entry> processLine(TextView line,
                               const Url &parent) noexcept override;

    //-----------------------------------------------------------------
    /// @details
    ///		Process the entry
    /// @param[in] entry
    ///		The entry to process
    //-----------------------------------------------------------------
    Error processItem(Entry &entry) noexcept override;

    //-----------------------------------------------------------------
    /// @details
    ///		Process the entries in a batch
    /// @param[in] entry
    ///		The entries to process in a batch
    //-----------------------------------------------------------------
    ErrorOr<size_t> processItems(std::vector<Entry> &entries) noexcept override;

    //-----------------------------------------------------------------
    /// @details
    ///		Finish the task
    //-----------------------------------------------------------------
    Error endTask() noexcept override;
};
}  // namespace engine::task::permissions
