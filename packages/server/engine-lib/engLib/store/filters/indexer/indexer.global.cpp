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

namespace engine::store::filter::indexer {
//-------------------------------------------------------------------------
/// @details
///		Gain a shared lock on the db
///	@returns
///		Error
//-------------------------------------------------------------------------
async::SharedLock::SharedGuard IFilterGlobal::sharedLock() const noexcept {
    return m_dbLock.shared();
}

//-------------------------------------------------------------------------
/// @details
///		Gain an exclusive lock on the db
///	@returns
///		Error
//-------------------------------------------------------------------------
async::SharedLock::UniqueGuard IFilterGlobal::lock() const noexcept {
    LOGT("Requesting exclusive lock");
    return m_dbLock.acquire();
}

//-------------------------------------------------------------------------
/// @details
///		Opends up the word database
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterGlobal::beginFilterGlobal() noexcept {
    LOGPIPE();

    // Call our parent first
    if (auto ccode = Parent::beginFilterGlobal()) return ccode;

    // Based on target or source mode, we do different things
    switch (endpoint->config.endpointMode) {
        case ENDPOINT_MODE::TARGET: {
            // In target mode, we are writing the word db

            // Get our index section
            const json::Value &indexConfig =
                endpoint->config.taskConfig.lookup("index");

            // Get our parameters
            if (auto ccode = indexConfig.lookupAssign<bool>("compress",
                                                            m_indexCompress) ||
                             indexConfig.lookupAssign<Url>("indexOutput",
                                                           m_indexOutput) ||
                             indexConfig.lookupAssign<uint64_t>(
                                 "batchId", m_indexBatchId) ||
                             indexConfig.lookupAssign<uint64_t>(
                                 "maxWordCount", m_maxWordCount) ||
                             indexConfig.lookupAssign<uint64_t>("maxItemCount",
                                                                m_maxItemCount))
                return ccode;

            // Set the path
            if (!m_indexOutput)
                return APERRT(Ec::InvalidParam,
                              "No output specified in index config");

            // Open a word db
            if (auto ccode = openWordDb()) return ccode;
            break;
        }

        case ENDPOINT_MODE::SOURCE: {
            // In source mode, we are reading the word dbs and rendering text

            // Lookup the batch map
            if (auto ccode = endpoint->config.taskConfig.lookupAssign(
                    "batches", m_batches))
                return ccode;

            break;
        }
    }

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Commit the word database
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterGlobal::endFilterGlobal() noexcept {
    LOGPIPE();

    // Based on target or source mode, we do different things
    switch (endpoint->config.endpointMode) {
        case ENDPOINT_MODE::TARGET: {
            // In target mode, we are writing the word db

            // Close the db and start writing it if needed
            if (auto ccode = closeWordDb()) return ccode;

            // Wait for the previous word DB to finish writing
            if (auto ccode = waitWordDbWriter())
                return APERRT(ccode, "Failed to write write final word DB");

            // Call our parent first
            if (auto ccode = Parent::endFilterGlobal()) return ccode;
            break;

            case ENDPOINT_MODE::SOURCE: {
                // In source mode, we are reading the word db and renderingtext
                break;
            }
        }
    }

    // And done
    return {};
}
}  // namespace engine::store::filter::indexer
