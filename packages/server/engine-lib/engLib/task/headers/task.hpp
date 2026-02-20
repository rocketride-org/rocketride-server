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

namespace engine::task {
//-------------------------------------------------------------------------
/// @details
///		Forward declare so Exec task can get to it
//-------------------------------------------------------------------------
extern Error executeTask(const file::Path &path, json::Value &value) noexcept;

//-------------------------------------------------------------------------
/// @details
///		Forward declare so that python dbgconn can see it
//-------------------------------------------------------------------------
extern Error executeArguments(std::vector<Text> args) noexcept;

//-------------------------------------------------------------------------
/// @details
///		This is used t store away detailed errors from executeArguments
///		which cannot cross the language boundaries
//-------------------------------------------------------------------------
extern void setExecuteTaskArgumentsCompletion(Error &ccode) noexcept;

//-------------------------------------------------------------------------
/// @details
///		Define the  task interface class which is the basis of all jobs
///		in the engine
//-------------------------------------------------------------------------
class ITask {
public:
    //-----------------------------------------------------------------
    /// @details
    ///		Our log level for LOGT macros
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::Job;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto FactoryType = "task";

    //-----------------------------------------------------------------
    /// @details
    ///		Define the factory arguments all jobs get
    //-----------------------------------------------------------------
    struct FactoryArgs {
        const file::Path path;
        json::Value cmd;
    };

    //-----------------------------------------------------------------
    /// @details
    ///		Create a job of the given type
    //-----------------------------------------------------------------
    static ErrorOr<Ptr<ITask>> __factory(Location location,
                                         uint32_t requiredFlags,
                                         FactoryArgs args) noexcept {
        // Find the task factory
        return Factory::find<ITask>(location, requiredFlags,
                                    buildType(args.cmd), args);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Generate a sring from this class for outtping to the
    ///		debug lines. We compuete the rates based on the
    ///		the current counters
    //-----------------------------------------------------------------
    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << m_type;
        _tsb(buff, " ", MONITOR(rate));
    }

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    ITask(FactoryArgs args) noexcept(false) : m_args(_mv(args)) {
        // Get the type
        m_type = buildType(m_args.cmd);

        // Save the optional path to the task file
        taskPath = m_args.path;
    }
    virtual ~ITask() = default;

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    json::Value &jobConfig() noexcept;
    json::Value &taskConfig() noexcept;
    store::pipeline::PipelineConfig &pipelineConfig() noexcept;
    const Text &type() const noexcept;

    virtual Error execute() noexcept;
    static Text buildType(json::Value &cmd) noexcept;

protected:
    //-----------------------------------------------------------------
    // Protected interfaces which can/must be implemented
    //-----------------------------------------------------------------
    virtual Error beginTask() noexcept;
    virtual Error exec() noexcept = 0;
    virtual Error endTask() noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Path of the task - may be null
    //-----------------------------------------------------------------
    file::Path taskPath;

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Contains the arguments passed to our constructor which
    ///		contains a single value .cmd, which contains the entire
    ///		json script for the task
    //-----------------------------------------------------------------
    FactoryArgs m_args;

    //-----------------------------------------------------------------
    /// @details
    ///		Extracted type
    //-----------------------------------------------------------------
    Text m_type;

    //-----------------------------------------------------------------
    /// @details
    ///		Forces a crash (testing)
    //-----------------------------------------------------------------
    bool m_crash = {};

    //-----------------------------------------------------------------
    /// @details
    ///		If true job is a null op, used for developer convenience,
    ///		prevents commenting out entire jobs can just set skip: true
    //-----------------------------------------------------------------
    bool m_skip = false;

    //-----------------------------------------------------------------
    /// @details
    ///		The pipeline configuration wrapper to the task
    ///		configuration for the pipeline tasks.
    //-----------------------------------------------------------------
    store::pipeline::PipelineConfig m_pipelineConfig;
};
}  // namespace engine::task
