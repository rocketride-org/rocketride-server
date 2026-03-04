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

Error init() noexcept {
    // Register our job factories
    auto ccode = Factory::registerFactory(
        // Pipe oriented tasks
        task::actionCopy::Task::Factory, task::actionExport::Task::Factory,
        task::actionRemove::Task::Factory, task::actionVerify::Task::Factory,
        task::actionTransform::Task::Factory, task::classify::Task::Factory,
        task::instance::Task::Factory, task::stat::Task::Factory,
        task::transform::Task::Factory, task::updateObjects::Task::Factory,
        task::permissions::Task::Factory, task::pipeline::Task::Factory,

        // Non-pipe oriented tasks
        task::classifyFiles::Task::Factory,
        task::configureService::Task::Factory, task::exec::Task::Factory,
        task::generateKey::Task::Factory, task::monitorTest::Task::Factory,
        task::scan::catalog::Task::Factory, task::scan::console::Task::Factory,
        task::commitScan::Task::Factory, task::searchBatch::Task::Factory,
        task::services::Task::Factory, task::sysinfo::Task::Factory,
        task::tokenize::Task::Factory, task::validateRegex::Task::Factory);

    if (ccode) {
        deinit();
        return ccode;
    }

    return {};
}

void deinit() noexcept {
    // Register our job factories
    Factory::deregisterFactory(
        // Pipe oriented tasks
        task::actionCopy::Task::Factory, task::actionExport::Task::Factory,
        task::actionRemove::Task::Factory, task::actionVerify::Task::Factory,
        task::actionTransform::Task::Factory, task::classify::Task::Factory,
        task::instance::Task::Factory, task::stat::Task::Factory,
        task::transform::Task::Factory, task::updateObjects::Task::Factory,
        task::permissions::Task::Factory, task::pipeline::Task::Factory,

        // Non-pipe oriented tasks
        task::classifyFiles::Task::Factory,
        task::configureService::Task::Factory, task::exec::Task::Factory,
        task::generateKey::Task::Factory, task::monitorTest::Task::Factory,
        task::scan::catalog::Task::Factory, task::scan::console::Task::Factory,
        task::commitScan::Task::Factory, task::searchBatch::Task::Factory,
        task::services::Task::Factory, task::sysinfo::Task::Factory,
        task::tokenize::Task::Factory, task::validateRegex::Task::Factory);
}

}  // namespace engine::task
