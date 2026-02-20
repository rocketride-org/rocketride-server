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

namespace engine::task::sysinfo {
//-------------------------------------------------------------------------
/// @details
///		Defines the sysinfo task. This is a standalone task that is used
///		to gather information about the system
//-------------------------------------------------------------------------
class Task : public ITask {
public:
    using Parent = ITask;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our log level
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobSysInfo;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, ITask>("sysinfo");

protected:
    //-----------------------------------------------------------------
    ///	@details
    ///		Execute the task - send results over the >INFO channel
    //-----------------------------------------------------------------
    Error exec() noexcept override {
        // Get our system info
        auto si = sysInfo();
        if (!si) return si.ccode();

        // Send it out
        MONITOR(info, "sysinfo", _tj(*si));
        return {};
    }
};

}  // namespace engine::task::sysinfo
