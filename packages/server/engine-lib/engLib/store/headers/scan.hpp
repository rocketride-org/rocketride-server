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

namespace engine::store::scan {
//-------------------------------------------------------------------------
// Use the standard file path
//-------------------------------------------------------------------------
using Path = ap::file::Path;

//-------------------------------------------------------------------------
/// @details
///     Each scan thread is given it's own scannng context
///		which we use to gather up the containers and objects
///		before we write them out
//-------------------------------------------------------------------------
struct ScanContext {
    //-----------------------------------------------------------------
    /// @details
    ///		Contains the current path being scanned
    //-----------------------------------------------------------------
    Path currentPath{};

    //-----------------------------------------------------------------
    /// @details
    ///		Contains the current stack of the objects being scanned
    ///		by sync service
    //-----------------------------------------------------------------
    SyncEntryStack entryStack;

    //-----------------------------------------------------------------
    /// @details
    ///		Contains the offset/size of data current in the buffer
    //-----------------------------------------------------------------
    size_t bufferOffset = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		Contains the count/size of objects in the buffer
    //-----------------------------------------------------------------
    CountSize objectCount = {};

    //-----------------------------------------------------------------
    /// @details
    ///		Flag to indicate we have entered a new directory
    //-----------------------------------------------------------------
    bool outputContainer = true;

    //-----------------------------------------------------------------
    /// @details
    ///		Current object line we are formatting
    //-----------------------------------------------------------------
    Text objectLine;

    //-----------------------------------------------------------------
    /// @details
    ///		Current container line we are formatting
    //-----------------------------------------------------------------
    Text containerLine;

    //-----------------------------------------------------------------
    /// @details
    ///		The buffer we gather entries into
    //-----------------------------------------------------------------
    TextChr buffer[1_mb]{};

private:
    //-----------------------------------------------------------------
    // Prohibit creation on the stack. It is required because the
    // ScanContext is too big to be used on the stack.
    //-----------------------------------------------------------------
    ScanContext() = default;

public:
    static std::unique_ptr<ScanContext> createInstance() noexcept {
        return std::unique_ptr<ScanContext>(new ScanContext());
    }
};

//-------------------------------------------------------------------------
///	@details
///		Define the scan job controlling class
//-------------------------------------------------------------------------
class Scanner {
public:
    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    virtual ~Scanner() noexcept { m_queue.stop(); }

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobScan;

    //-----------------------------------------------------------------
    // Public API - scan the given service
    //-----------------------------------------------------------------
    virtual Error scan(ServiceEndpoint endpoint) noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		Out current service protocol
    //-----------------------------------------------------------------
    iText scanProtocol;

    //-----------------------------------------------------------------
    ///	@details
    ///		Out current service protocol
    //-----------------------------------------------------------------
    uint32_t scanProtocolCaps = 0;

    //-----------------------------------------------------------------
    ///	@details
    ///		Our current service key
    //-----------------------------------------------------------------
    iText scanServiceKey;

protected:
    //-----------------------------------------------------------------
    // Protected API
    //-----------------------------------------------------------------
    virtual Error addScanObject(ScanContext &context, Entry &object,
                                const Path &path) noexcept = 0;
    virtual Error flushContext(ScanContext &context) noexcept { return {}; };
    virtual Error flushTask() noexcept { return {}; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Keep track of any fatal errors that we will fail the
    ///		task over
    //-----------------------------------------------------------------
    Error m_fatalError{};

private:
    //-----------------------------------------------------------------
    // Private API
    //-----------------------------------------------------------------
    virtual Error checkLicenseLimits();
    virtual Error addScanContainer(Path &objectPath) noexcept;
    virtual Error addEntry(ScanContext &context, Entry &object) noexcept;
    virtual Error scanContainer(ScanContext &context, Path &path) noexcept;
    virtual Error scanProcess() noexcept;
    virtual Error scanService() noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		The current endpoint we are scanning
    //-----------------------------------------------------------------
    ErrorOr<ServiceEndpoint> m_endpoint;

    //-----------------------------------------------------------------
    ///	@details
    ///		Mutex for state
    //-----------------------------------------------------------------
    mutable async::MutexLock m_lock{};

    //-----------------------------------------------------------------
    ///	@details
    ///		Lock for updating objectCount/Size
    //-----------------------------------------------------------------
    mutable async::MutexLock m_licenseLock{};

    //-----------------------------------------------------------------
    ///	@details
    ///		The number of threads to tackle the scan
    //-----------------------------------------------------------------
    uint32_t m_threadCount = 2;

    //-----------------------------------------------------------------
    ///	@details
    ///		Threaded queue which contains the paths which we need to
    ///		scan
    //-----------------------------------------------------------------
    async::ThreadedQueue<Path> m_queue;

    //-----------------------------------------------------------------
    ///	@details
    ///		Licensing info
    //-----------------------------------------------------------------
    CountSize m_accumCounts = {};

    //-----------------------------------------------------------------
    /// @details
    ///		Licensing control
    //-----------------------------------------------------------------
    CountSize m_licenseLimits;
    bool m_unlimitedCount = false;
    bool m_unlimitedSize = false;
    bool m_licenseLimitReached = false;

    //-----------------------------------------------------------------
    /// @details
    ///		The service we are going to scan
    //-----------------------------------------------------------------
    json::Value m_service;

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		is pipeline working in direct mode or no
    //-----------------------------------------------------------------
    bool m_directMode = false;
};
}  // namespace engine::store::scan
