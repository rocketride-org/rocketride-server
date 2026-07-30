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

namespace engine::task {
namespace {
//-------------------------------------------------------------------------
/// @details
///		The task-file JSON of the task currently executing in this
///		process (null when none). Set/cleared and read on the main task
///		thread only (the getTask() binding is consumed at endpoint
///		construction, inside the publish window) — publish, reads, and
///		clear are strictly sequential on that one thread, so no
///		synchronization is needed.
//-------------------------------------------------------------------------
json::Value g_currentTask;
}  // namespace

//-------------------------------------------------------------------------
/// @details
///		Signal the the task is beginning
//-------------------------------------------------------------------------
Error ITask::beginTask() noexcept {
    MONITOR(reset);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Execute the job
//-------------------------------------------------------------------------
Error ITask::execute() noexcept {
    // Start/stop the counters
    util::Guard countScope{[&] { MONITOR(startCounters); },
                           [&] { MONITOR(stopCounters); }};

    // Ouput to the log
    LOGT("Job {} starting", type());
    LOGT("Config:", m_args.cmd);

    // Get the crash and skip flags
    if (auto ccode = taskConfig().lookupAssign("crash", m_crash) ||
                     taskConfig().lookupAssign("skip", m_skip)) {
        return ccode;
    }

    // If crashing, do so now
    if (m_crash) {
        LOG(Always, "********FORCING CRASH********");
        int *ptr = {};
        *ptr = 0;

        // Ensure it is not optimized out
        (void)ptr;
    }

    // If this is an auto-skip, skip it
    if (m_skip) {
        // Output a warning and return
        MONERR(warning, Ec::Excluded, "Job marked for skip");
        return {};
    }

    // Debug
    LOGT("Started", type());

    // Publish this task for rocketlib.getTask(). Set BEFORE beginTask —
    // endpoint construction (and the python nodes' global initialization)
    // happens inside it — and cleared by the guard on EVERY exit path, so
    // an errored task never leaves a stale publication behind.
    util::Guard taskScope{[&] { setCurrentTask(m_args.cmd); },
                          [&] { setCurrentTask({}); }};

    // Allow the task to read any configuration it needs
    if (auto ccode = beginTask()) return ccode;

    // Execute the job
    if (auto ccode = exec()) return ccode;

    // End the task
    if (auto ccode = endTask()) return ccode;

    // And done
    LOGT("Job {} completed successfully", type());
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Return a reference to the job configuration
//-------------------------------------------------------------------------
json::Value &ITask::jobConfig() noexcept { return m_args.cmd; }

//-------------------------------------------------------------------------
/// @details
///		Return a copy of the currently-executing task's file JSON —
///		null when no task is running. Main-task-thread only (see
///		g_currentTask above): publish, read, and clear are sequential
///		on that one thread.
//-------------------------------------------------------------------------
json::Value ITask::currentTask() noexcept { return g_currentTask; }

//-------------------------------------------------------------------------
/// @details
///		Publish (or, with a null value, clear) the currently-executing
///		task for currentTask() readers
//-------------------------------------------------------------------------
void ITask::setCurrentTask(const json::Value &task) noexcept {
    g_currentTask = task;
}

//-------------------------------------------------------------------------
/// @details
///		Return a reference to the task configuration
//-------------------------------------------------------------------------
json::Value &ITask::taskConfig() noexcept { return m_args.cmd["config"]; }

store::pipeline::PipelineConfig &ITask::pipelineConfig() noexcept {
    return m_pipelineConfig;
}

//-------------------------------------------------------------------------
/// @details
///		Return a reference to the job type
//-------------------------------------------------------------------------
const Text &ITask::type() const noexcept { return m_type; }

//-------------------------------------------------------------------------
/// @details
///		Build the type from the confguration supplied
///
///		The main command entry has type, which can be a "type" or
///		"type.subtype" or can be specified as a separate "type" and
///		"subtype" value.
///
///		This will also look in the cmd.config section for "action", and
///		if found, will use it as the "subtype". This is mainly for
///		legacy purposes.
///
///		It is preferable to use the "type": "type.subtype" in the
///		command entry going forward
///
///	@param[in] cmd
///		The task command
//-------------------------------------------------------------------------
Text ITask::buildType(json::Value &cmd) noexcept {
    // Get the type
    Text majorType = cmd.lookup<Text>("type");

    // And any associtated subtype of action
    Text minorType = cmd.lookup<Text>("subtype");

    if (!minorType) {
        auto taskConfig = cmd.lookup("config");
        minorType = taskConfig.lookup<Text>("action");
    }

    // If we have a minor type, add it
    if (minorType)
        return majorType + "." + minorType;
    else
        return majorType;
}

//-------------------------------------------------------------------------
/// @details
///		Sigal that the task is ending
//-------------------------------------------------------------------------
Error ITask::endTask() noexcept { return {}; }
}  // namespace engine::task
