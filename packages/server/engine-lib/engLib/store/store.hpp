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

//-----------------------------------------------------------------------------
// Helpful macro to log our pipe activities
//-----------------------------------------------------------------------------

// Takes a filter reference and a function
#if ROCKETRIDE_PLAT_WIN
#define LOGPIPE_EX(pipeType, func, ...) \
    LOG(ServicePipe, this, func, ":", pipeType.id, __VA_ARGS__)
#else
#define LOGPIPE_EX(pipeType, func, ...) \
    LOG(ServicePipe, this, func, ":", pipeType.id __VA_OPT__(, ) __VA_ARGS__)
#endif

// Uses the current filter and function reference to where this is included
#if ROCKETRIDE_PLAT_WIN
#define LOGPIPE(...) LOGPIPE_EX(this->pipeType, __func__, __VA_ARGS__)
#else
#define LOGPIPE(...) \
    LOGPIPE_EX(this->pipeType, __func__ __VA_OPT__(, ) __VA_ARGS__)
#endif

//-----------------------------------------------------------------------------
// Includes all the header files to support the engine::store namespace
//-----------------------------------------------------------------------------
#include "./headers/types.hpp"
#include "./headers/tags.hpp"
#include "./headers/ioctrl.hpp"
#include "./headers/services.hpp"
#include "./pipeline/pipeline_config.hpp"
#include "./headers/config.hpp"
#include "./headers/iobuffer.hpp"
#include "./headers/memory.hpp"
#include "./headers/binder.hpp"
#include "./headers/debugger.hpp"
#include "./headers/endpoint.hpp"
#include "./headers/filter.hpp"
#include "./headers/iBuffer.hpp"
#include "./headers/virtualBuffer.hpp"
#include "./headers/memoryBuffer.hpp"
#include "./headers/scan.hpp"
#include "./headers/loader.hpp"
#include "./filters/pipe/pipe.hpp"
#include "./python/python-base.hpp"

#include "./endpoints/azure/azure.hpp"
#include "./endpoints/filesys/filesys/filesys.hpp"
#include "./endpoints/filesys/smb/smb.hpp"
#include "./endpoints/objstore/s3/s3.hpp"
#include "./endpoints/objstore/objstore/objstore.hpp"
#include "./endpoints/null/null.hpp"
#include "./endpoints/zip/zip.hpp"
#include "./endpoints/python/python.hpp"

#include "./filters/bottom/bottom.hpp"
#include "./filters/classify/classify.hpp"
#include "./filters/hash/hash.hpp"
#include "./filters/indexer/indexer.hpp"
#include "./filters/parse/parse.hpp"

#include "./endpoints/msServices/outlook/constants.hpp"
#include "./endpoints/msServices/msConnector/MsConnector.hpp"
#include "./endpoints/msServices/msConnector/MsSharepointConnector/MsSharepointConnector.hpp"
#include "./endpoints/msServices/msConnector/MsEmailConnector/MsEmailConnector.hpp"
#include "./endpoints/msServices/msConnector/MsEmailConnector/MsEmailContainer.hpp"
#include "./endpoints/msServices/sharepoint/base.hpp"
#include "./endpoints/msServices/outlook/base.hpp"

#include "./pipeline/validate_pipeline.hpp"

namespace engine::store {
Error init() noexcept;
void deinit() noexcept;
}  // namespace engine::store
