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
// We use the store ** A LOT **, so include it
//-------------------------------------------------------------------------
using namespace engine::store;
}  // namespace engine::task

//-----------------------------------------------------------------------------
// Includes all the header files to support the engine::task namespace
//-----------------------------------------------------------------------------
#include "./headers/task.hpp"
#include "./headers/pipetask.hpp"

#include "./pipe/Action.BaseCopy.hpp"
#include "./pipe/Action.Copy.hpp"
#include "./pipe/Action.Export.hpp"
#include "./pipe/Action.Remove.hpp"
#include "./pipe/Action.Verify.hpp"
#include "./pipe/Action.Transform.hpp"
#include "./pipe/Classify.hpp"
#include "./pipe/Instance.hpp"
#include "./pipe/Pipeline.hpp"
#include "./pipe/Stat.hpp"
#include "./pipe/UpdateObjects.hpp"
#include "./pipe/Permissions.hpp"

#include "./tasks/ClassifyFiles.hpp"
#include "./tasks/ConfigureService.hpp"
#include "./tasks/Exec.hpp"
#include "./tasks/GenerateKey.hpp"
#include "./tasks/MonitorTest.hpp"
#include "./tasks/ScanCatalog.hpp"
#include "./tasks/ScanConsole.hpp"
#include "./tasks/CommitScan.hpp"
#include "./tasks/SearchBatch.hpp"
#include "./tasks/Services.hpp"
#include "./tasks/Sysinfo.hpp"
#include "./tasks/Tokenize.hpp"
#include "./tasks/Transform.hpp"
#include "./tasks/ValidateRegex.hpp"

namespace engine::task {
//-------------------------------------------------------------------------
// We use the store ** A LOT **, so include it
//-------------------------------------------------------------------------
using namespace engine::store;

//-------------------------------------------------------------------------
// The main core task runner
//-------------------------------------------------------------------------
Error Main() noexcept;

//-------------------------------------------------------------------------
// Init/deinit for the task manager
//-------------------------------------------------------------------------
Error init() noexcept;
void deinit() noexcept;

//-------------------------------------------------------------------------
// Default _tsbo flags
//-------------------------------------------------------------------------
_const auto DefFormatFlags =
    Format::NOFAIL | Format::APPEND | Format::DOUBLE_DELIMOK;

//-------------------------------------------------------------------------
// Default _tsbo options
//-------------------------------------------------------------------------
static inline FormatOptions defFormatOptions(
    uint32_t additionalFlags = {}) noexcept {
    return {DefFormatFlags | additionalFlags, 0, '*'};
}
}  // namespace engine::task
