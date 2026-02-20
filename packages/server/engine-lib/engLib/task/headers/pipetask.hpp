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
// Define our schema description
//-------------------------------------------------------------------------
enum PipeTaskSchema { JSONPIPE = 10 };

//-------------------------------------------------------------------------
/// @details
///		A header is a json object on the first line of a request file, it
///		describes the content and is used for validation of inputs
///		to pipe oriented jobs
//-------------------------------------------------------------------------
struct PipeTaskHeader {
    //-----------------------------------------------------------------
    ///	@details
    ///		The schema which defines the format of the input and output
    //-----------------------------------------------------------------
    uint32_t schema = {};

    //-----------------------------------------------------------------
    ///	@details
    ///		Type of this pipe
    //-----------------------------------------------------------------
    Text type;

    //-----------------------------------------------------------------
    ///	@details
    ///		The version of the application
    //-----------------------------------------------------------------
    Text appVersion;

    //-----------------------------------------------------------------
    ///	@details
    ///		The version of the engine
    //-----------------------------------------------------------------
    Text engineVersion = application::projectVersion();

    //-----------------------------------------------------------------
    ///	@details
    ///		Define the json schema so we can convert this to
    ///		a json structure
    //-----------------------------------------------------------------
    auto __jsonSchema() const noexcept {
        return json::makeSchema(type, "type", schema, "schema", appVersion,
                                "appVersion", engineVersion, "engineVersion");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		And convert this to a string
    //-----------------------------------------------------------------
    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff.write(_tj(*this).stringify());
    }
};

//-------------------------------------------------------------------------
/// @details
///		This is the base without any templates so we can pass these over
///		to the endpoints to be able to call
//-------------------------------------------------------------------------
class IPipeTaskBase : public ITask {
public:
    using Parent = ITask;
    using Parent::Parent;

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error writeText(const Text &text) noexcept { return {}; }
    virtual Error writeWarning(const Entry &entry,
                               const Error &ccode) noexcept {
        return {};
    }
};

//-------------------------------------------------------------------------
/// @details
///		Response oriented job, performs some action on files from a
///		request stream and outputs a response stream
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
class IPipeTask : public IPipeTaskBase {
public:
    using Parent = IPipeTaskBase;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = LvlT;

    //-----------------------------------------------------------------
    /// @details
    ///		Static factory hook to create the appropriate type
    //-----------------------------------------------------------------
    static ErrorOr<Ptr<IPipeTask>> __factory(Location location,
                                             uint32_t requiredFlags,
                                             FactoryArgs args) noexcept {
        // Find the task factory
        return Factory::find<IPipeTask>(location, requiredFlags,
                                        buildType(args.cmd), args);
    }

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IPipeTask(FactoryArgs args) noexcept(false) : Parent(args) {}
    virtual ~IPipeTask<LvlT>() noexcept {
        // Stop the queue
        m_queue.stop();

        // Close the endpoints if we opened them
        if (m_sourceEndpoint) m_sourceEndpoint.reset();

        if (m_targetEndpoint) m_targetEndpoint.reset();

        // Close the output if needed
        closeOutput();
    }

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error writeText(const Text &text) noexcept override;
    virtual Error writeWarning(const Entry &entry,
                               const Error &ccode) noexcept override;

    virtual Error writeError(const Entry &entry,
                             const Error &errorCode) noexcept;
    virtual Error writeResult(const Text &value) noexcept;
    virtual Error writeResult(const TextChr responseType,
                              const json::Value &value) noexcept;
    virtual Error writeResult(const TextChr responseType,
                              const Entry &entry) noexcept;

protected:
    //-----------------------------------------------------------------
    // Misc functions
    //-----------------------------------------------------------------
    virtual Error setThreadCount(uint32_t threadCount);

    //-----------------------------------------------------------------
    // When a task is to be executed
    //      beginTask is called to prepare the endpoints
    //          exec is called to execute the task
    //              exec prepares and starts up the item queue,
    //              calls enumInput to start filling up the queue
    //              for every item found, it calls queueItem
    //              when a thread is available, it calls processItem
    //              to process which defaults to calling render
    //              object
    //      endTask is called to finish up the task
    //-----------------------------------------------------------------
    virtual Error processItem(Entry &item, ServicePipe &sourcePipe) noexcept;
    virtual Error processItem(Entry &item) noexcept;
    virtual Error queueItem(Entry &item) noexcept;
    virtual Error enumInput() noexcept;

    //-----------------------------------------------------------------
    // These are used for bulk processing
    //-----------------------------------------------------------------
    virtual Error processItems() noexcept;
    virtual ErrorOr<size_t> processItems(std::vector<Entry> &items) noexcept;
    virtual uint32_t getThreadCount(uint32_t currentThreadCount) const noexcept;

    //-----------------------------------------------------------------
    // These are used for input/output pipes
    //-----------------------------------------------------------------
    virtual Error buildHeader(PipeTaskHeader &hdr) noexcept;
    virtual Error processHeader(const PipeTaskHeader &hdr) noexcept;
    virtual ErrorOr<Entry> processLine(TextView opType, TextView line,
                                       const Url &currentParent) noexcept;
    virtual ErrorOr<Entry> processLine(TextView line,
                                       const Url &currentParent) noexcept;

    //-----------------------------------------------------------------
    // The 3 main entry points to the task
    //-----------------------------------------------------------------
    virtual Error beginTask() noexcept override;
    virtual Error exec() noexcept override;
    virtual Error endTask() noexcept override;

protected:
    //-----------------------------------------------------------------
    ///	@details
    ///		The task id of this task
    //-----------------------------------------------------------------
    Text m_taskId;

    //-----------------------------------------------------------------
    ///	@details
    ///		Counts the number of failures that have occured on
    /// 	processing items in the queue. Once a threshhold is
    ///		reached, processItem should signal a terminal error
    //-----------------------------------------------------------------
    uint32_t m_consecutiveFailures = 0;

    //-----------------------------------------------------------------
    ///	@details
    ///		The maximum number of consecutive failures before the
    ///		task is terminated
    //-----------------------------------------------------------------
    uint32_t m_maxConsecutiveFailures = 50;

    //-----------------------------------------------------------------
    ///	@details
    ///		Mutex for state
    //-----------------------------------------------------------------
    mutable async::MutexLock m_consecutiveLock{};

    //-----------------------------------------------------------------
    ///	@details
    ///		The number of threads to tackle the task queue
    //-----------------------------------------------------------------
    Error m_terminalError;

    //-----------------------------------------------------------------
    ///	@details
    ///		The number of threads to tackle the task queue
    //-----------------------------------------------------------------
    uint32_t m_threadCount = 2;

    //-----------------------------------------------------------------
    ///	@details
    ///		Depth of our in memory queues - how many Items we
    ///		read and place in th pending queue
    //-----------------------------------------------------------------
    size_t m_queueDepth = 256;

    //-----------------------------------------------------------------
    ///	@details
    ///		The output file specified
    //-----------------------------------------------------------------
    Url m_outputUrl;

    //-----------------------------------------------------------------
    ///	@details
    ///		The input file specified
    //-----------------------------------------------------------------
    Url m_inputUrl;

    //-----------------------------------------------------------------
    /// @details
    ///		Where are reading from - allow child classes access
    //-----------------------------------------------------------------
    ErrorOr<ServiceEndpoint> m_sourceEndpoint;

    //-----------------------------------------------------------------
    /// @details
    ///		Where are writing to - allow child classes access
    //-----------------------------------------------------------------
    ErrorOr<ServiceEndpoint> m_targetEndpoint;

protected:
    //-----------------------------------------------------------------
    // Protected API
    //-----------------------------------------------------------------
    Error wrapError(const Entry &entry, const Error &error) noexcept;

private:
    //-----------------------------------------------------------------
    // Private API
    //-----------------------------------------------------------------
    bool isDirectoryEntry(TextView line) noexcept;
    bool isComment(TextView line) noexcept;
    Error openOutput() noexcept;
    Error closeOutput() noexcept;

    Error startQueue() noexcept;
    Error waitForComplete() noexcept;
    Error processThread() noexcept;
    Error processInput(TextView line, Url &currentParent) noexcept;
    void handleTerminalError(const Error &ccode) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Current header we loaded from the request stream
    //-----------------------------------------------------------------
    Opt<PipeTaskHeader> m_header;

    //-----------------------------------------------------------------
    /// @details
    ///		Output stream for the response file if specified
    //-----------------------------------------------------------------
    ErrorOr<StreamPtr> m_output;

    //-----------------------------------------------------------------
    /// @details
    ///		The lock to output data to he output via writeText
    //-----------------------------------------------------------------
    mutable async::MutexLock m_outputLock{};

    //-----------------------------------------------------------------
    /// @details
    ///		Queues of threads for pipelining items to process
    //-----------------------------------------------------------------
    async::ThreadedQueue<Entry> m_queue;
};

}  // namespace engine::task
