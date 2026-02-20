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

namespace engine::task::actionCopy {
//-------------------------------------------------------------------------
/// @details
///		Defines the action.copy action
//-------------------------------------------------------------------------
class Task : public ::engine::task::actionBaseCopy::Task {
public:
    using Parent = typename ::engine::task::actionBaseCopy::Task;
    using Parent::Parent;

    //-----------------------------------------------------------------
    /// @details
    ///		Define our factory info
    //-----------------------------------------------------------------
    _const auto Factory =
        Factory::makeFactory<Task, IPipeTask<Lvl::JobAction>>("action.copy");

    //-----------------------------------------------------------------
    /// @details
    ///		Setup for a copy operation
    //-----------------------------------------------------------------
    Error beginTask() noexcept override;

    //-----------------------------------------------------------------
    /// @details
    ///		Copy an entry from the source to the target
    /// @param[in] entry
    ///		The entry to copy
    //-----------------------------------------------------------------
    Error processItem(Entry& entry) noexcept override;
};
}  // namespace engine::task::actionCopy
