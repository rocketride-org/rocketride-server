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

namespace engine::task::commitScan {
//-------------------------------------------------------------------------
/// @details
///		Defines the services task which outputs the defined services
///		(from the services folder) and outputs them to the MONINFO
//-------------------------------------------------------------------------
class Task : public ITask {
public:
    using Parent = ITask;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our log level
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobScan;

    //-----------------------------------------------------------------
    /// @details
    ///		The name of this component
    //-----------------------------------------------------------------
    _const auto Type = "commitScan"_tv;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, ITask>(Type);

protected:
    //-----------------------------------------------------------------
    ///	@details
    ///		Execute the task - commit sync tokens
    //-----------------------------------------------------------------
    Error exec() noexcept override {
        // Get endpoint config
        json::Value serviceConfig;
        if (auto ccode = taskConfig().lookupAssign("service", serviceConfig))
            return ccode;

        // Create endpoint instance
        auto sourceEndpoint =
            IServiceEndpoint::getSourceEndpoint({.jobConfig = jobConfig(),
                                                 .taskConfig = taskConfig(),
                                                 .serviceConfig = serviceConfig,
                                                 .openMode = OPEN_MODE::SCAN});

        // Check if endpoint is ok
        if (!sourceEndpoint) return sourceEndpoint.ccode();

        // Commit sync tokens
        auto ccode = sourceEndpoint->commitScan();

        // Close out the source endpoint if we have one
        if (sourceEndpoint) {
            if (auto endCode = sourceEndpoint->endEndpoint())
                ccode = (endCode ||
                         APERRT(endCode, "Failed to end target endpoint"));
            sourceEndpoint.reset();
        }

        return ccode;
    }
};
}  // namespace engine::task::commitScan
