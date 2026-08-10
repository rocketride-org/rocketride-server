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

// Members are defined out of the header, so every task level is instantiated
// below; add new levels there or linking fails
#include "pipetask.output.ipp"
#include "pipetask.process.ipp"

namespace engine::task {
//-------------------------------------------------------------------------
/// @details
///		Sets the number of threads that can be run through the
///     queue. This must be called after Parent::beginTask but before
///     Parent::exec
///	@returns
///		Error
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
Error IPipeTask<LvlT>::setThreadCount(uint32_t threadCount) {
    m_threadCount = threadCount;
    return {};
}

template class IPipeTask<Lvl::JobAction>;
template class IPipeTask<Lvl::JobClassify>;
template class IPipeTask<Lvl::JobInstance>;
template class IPipeTask<Lvl::JobPermissions>;
template class IPipeTask<Lvl::JobPipeline>;
template class IPipeTask<Lvl::JobScan>;
template class IPipeTask<Lvl::JobStat>;
}  // namespace engine::task
