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

//-----------------------------------------------------------------------------
//
//	Declares the interface for services and their pipes
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store {
namespace py = pybind11;

//-------------------------------------------------------------------------
/// @details
///		Define the things we are using
//-------------------------------------------------------------------------
using WordVector = std::vector<StackText>;

//-------------------------------------------------------------------------
/// @details
///		The message of the Ec::PipelineEnded error, which refuses an engine
///		call once its pipeline has ended. Node code compares exc.message
///		with it, together with the code, so the text is part of the
///		contract: do not change it.
//-------------------------------------------------------------------------
_const auto PipelineEndedMessage = "The pipeline has ended"_tv;

//-------------------------------------------------------------------------
/// @details
///		This is the filter driver which all filters/targets/sources must
///		implement
//-------------------------------------------------------------------------
class ROCKETRIDE_CORE_API IServiceFilterInstance {
public:
    //-----------------------------------------------------------------
    // Delete copy constructor and copy assignment operator. If you
    // get compile errors, you need to figure out why you are copying
    //-----------------------------------------------------------------
    IServiceFilterInstance(const IServiceFilterInstance &) = delete;
    IServiceFilterInstance &operator=(const IServiceFilterInstance &) = delete;

    //-----------------------------------------------------------------
    // Delete move constructor and move assignment operator. If you
    // get compile errors, you need to figure out why you are moving
    //-----------------------------------------------------------------
    IServiceFilterInstance(IServiceFilterInstance &&) = delete;
    IServiceFilterInstance &operator=(IServiceFilterInstance &&) = delete;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::ServiceFilter;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory type
    //-----------------------------------------------------------------
    _const auto FactoryType = "iFilterInstance";
    // Interfaces derived from this class share its factory registry, and every
    // method stored in it returns a pointer to this root
    using FactoryRoot = IServiceFilterInstance;

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << m_openMode << " [" << pipeId << "]";
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Factory args
    //-----------------------------------------------------------------
    struct FactoryArgs {
        IPipeType pipeType;
        ServiceEndpoint &endpoint;
        ServiceGlobal &global;
        ServicePipe &pipe;
    };

    //-----------------------------------------------------------------
    /// @details
    ///		Static factory hook to create the appropriate type
    //-----------------------------------------------------------------
    static ErrorOr<ServiceInstancePtr> __factory(Location location,
                                                 uint32_t requiredFlags,
                                                 FactoryArgs args) noexcept {
        return Factory::find<IServiceFilterInstance>(
            location, requiredFlags, args.pipeType.physicalType, args);
    }

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    virtual ~IServiceFilterInstance();
    IServiceFilterInstance(const FactoryArgs &args) noexcept
        : pipeType(args.pipeType),
          endpoint(args.endpoint),
          global(args.global),
          pipe(args.pipe),
          binder(this) {
        m_openMode = endpoint->config.openMode;
        LOGPIPE();
    };

    //-----------------------------------------------------------------
    // Public API - all modes
    //-----------------------------------------------------------------
    virtual Error beginFilterInstance() noexcept;
    virtual Error endFilterInstance() noexcept;
    virtual Error ioControl(IOCTRL *pCommand) noexcept {
        return pDown->ioControl(pCommand);
    }

    //-----------------------------------------------------------------
    // filter.source.cpp
    //
    // Source mode (only available when ENDPOINT_MODE::SOURCE)
    //		These functions are called by a source mode driver to send
    //		data to the target the eventual target. They will call
    //		down through the source chain, eventually end up in bottom
    //		which will forward them to the top of the target
    //-----------------------------------------------------------------
    virtual uint32_t getThreadCount(uint32_t currentThreadCount) const noexcept;
    virtual Error renderObject(ServicePipe &target, Entry &object) noexcept;
    virtual Error checkChanged(Entry &object) noexcept;
    virtual Error getPermissions(Entry &entry) noexcept;
    virtual ErrorOr<size_t> getPermissions(
        std::vector<Entry> &entries) noexcept;
    virtual Error prepareObject(Entry &entry) noexcept;
    virtual Error checkPermissions(Entry &object) noexcept;
    virtual ErrorOr<size_t> checkPermissions(
        std::vector<Entry> &entries) noexcept;
    virtual ErrorOr<bool> stat(Entry &entry) noexcept;
    virtual ErrorOr<std::list<Text>> outputPermissions() noexcept;

    virtual Error sendOpen(ServicePipe &target, Entry &entry) noexcept;
    virtual Error sendTag(ServicePipe &target, const TAG *pTag) noexcept;
    virtual Error sendTagMetadata(ServicePipe &target,
                                  json::Value &metadata) noexcept;
    virtual Error sendTagBeginObject(ServicePipe &target) noexcept;
    virtual Error sendTagBeginStream(ServicePipe &target) noexcept;
    virtual Error sendTagData(ServicePipe &target, size_t size,
                              const void *pData) noexcept;
    virtual Error sendTagEndStream(ServicePipe &target) noexcept;
    virtual Error sendTagEndObject(ServicePipe &target,
                                   Error completionCode) noexcept;
    virtual Error sendText(ServicePipe &target, const Utf16View &text) noexcept;
    virtual Error sendTable(ServicePipe &target,
                            const Utf16View &text) noexcept;
    virtual Error sendWords(ServicePipe &target,
                            const WordVector &textWords) noexcept;
    virtual Error sendJson(ServicePipe &target,
                           const json::Value &jsonData) noexcept;
    virtual Error sendAudio(ServicePipe &target, const AVI_ACTION action,
                            Text &mimeType,
                            const pybind11::bytes &streamData) noexcept;
    virtual Error sendVideo(ServicePipe &target, const AVI_ACTION action,
                            Text &mimeType,
                            const pybind11::bytes &streamData) noexcept;
    virtual Error sendImage(ServicePipe &target, const AVI_ACTION action,
                            Text &mimeType,
                            const pybind11::bytes &streamData) noexcept;
    virtual Error sendQuestions(ServicePipe &target,
                                const pybind11::object &question) noexcept;
    virtual Error sendAnswers(ServicePipe &target,
                              const pybind11::object &answers) noexcept;
    virtual Error sendClassifications(ServicePipe &target,
                                      const json::Value &classifications,
                                      const json::Value &,
                                      const json::Value &) noexcept;
    virtual Error sendClassificationContext(
        ServicePipe &target, const json::Value &classifications) noexcept;
    virtual Error sendDocuments(ServicePipe &target,
                                const pybind11::object &documents) noexcept;
    virtual Error sendClose(ServicePipe &target) noexcept;

    //-----------------------------------------------------------------
    // filter.target.cpp
    //
    // Target mode (only available when ENDPOINT_MODE::TARGET)
    //		These functions code be overriden by a filter driver
    //		to intercept data as it flows through the pipe. In addition,
    //		if you call these within the target, the call will be
    //		pass on to the next driver below. They can only be used
    //		when the endpoint is in TARGET mode
    //-----------------------------------------------------------------
    virtual Error control(py::object &control) noexcept { return {}; };
    virtual Error open(Entry &entry) noexcept;
    virtual Error writeTag(const TAG *pTag) noexcept {
        return binder.writeTag(pTag);
    }
    virtual Error writeText(const Utf16View &text) noexcept {
        return binder.writeText(text);
    }
    virtual Error writeTable(const Utf16View &text) noexcept {
        return binder.writeTable(text);
    };
    virtual Error writeWords(const WordVector &textWords) noexcept {
        return binder.writeWords(textWords);
    }
    virtual Error writeJson(const json::Value &jsonData) noexcept {
        return binder.writeJson(jsonData);
    }
    virtual Error writeAudio(const AVI_ACTION action, Text &mimeType,
                             const pybind11::bytes &streamData) noexcept {
        return binder.writeAudio(action, mimeType, streamData);
    };
    virtual Error writeVideo(const AVI_ACTION action, Text &mimeType,
                             const pybind11::bytes &streamData) noexcept {
        return binder.writeVideo(action, mimeType, streamData);
    };
    virtual Error writeImage(const AVI_ACTION action, Text &mimeType,
                             const pybind11::bytes &streamData) noexcept {
        return binder.writeImage(action, mimeType, streamData);
    };
    virtual Error writeQuestions(const pybind11::object &question) noexcept {
        return binder.writeQuestions(question);
    };
    virtual Error writeAnswers(const pybind11::object &answers) noexcept {
        return binder.writeAnswers(answers);
    };
    virtual Error writeClassifications(
        const json::Value &classifications,
        const json::Value &classificationPolicy,
        const json::Value &classificationRules) noexcept {
        return binder.writeClassifications(
            classifications, classificationPolicy, classificationRules);
    }
    virtual Error writeClassificationContext(
        const json::Value &classifications) noexcept {
        return binder.writeClassificationContext(classifications);
    }
    virtual Error writeDocuments(const pybind11::object &documents) noexcept {
        return binder.writeDocuments(documents);
    }
    virtual Error closing() noexcept { return binder.closing(); }
    virtual Error close() noexcept;
    virtual Error removeObject(Entry &entry) {
        return pDown->removeObject(entry);
    }

    //-----------------------------------------------------------------
    // filter.util.cpp
    //
    // Utility functions
    //-----------------------------------------------------------------
    virtual Error bindLinkages(size_t pipeId, size_t filterLevel,
                               ServiceInstance filterDown) noexcept final;
    virtual Error getTagBuffer(TAG **ppTag) noexcept;
    virtual Error getIOBuffer(IOBuffer **ppIOBuffer) noexcept;
    virtual bool isPrimaryDataStream(TAG_OBJECT_STREAM_BEGIN *pTag) noexcept;

    //-----------------------------------------------------------------
    // Public API	: python-instance.callbacks.cpp
    //		These are attached to the python instance to be called
    //		by renderObject
    //-----------------------------------------------------------------

    //---------------------------------
    // Source mode functions
    //	in python called by (for example)
    //		self.instance.sendText("str")
    //---------------------------------
    virtual void cb_sendOpen(Entry &object) noexcept(false);
    virtual void cb_sendTagMetadata(py::dict &metadata) noexcept(false);
    virtual void cb_sendTagBeginObject() noexcept(false);
    virtual void cb_sendTagBeginStream() noexcept(false);
    virtual void cb_sendTagData(py::object &data) noexcept(false);
    virtual void cb_sendText(const std::u16string &text) noexcept(false);
    virtual void cb_sendTable(const std::u16string &text) noexcept(false);
    virtual void cb_sendJson(python::IJson json) noexcept(false);
    virtual void cb_sendAudio(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept(false);
    virtual void cb_sendVideo(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept(false);
    virtual void cb_sendImage(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept(false);
    virtual void cb_sendQuestions(const pybind11::object &question) noexcept(
        false);
    virtual void cb_sendAnswers(const pybind11::object &answers) noexcept(
        false);
    virtual void cb_sendClassifications(
        const json::Value &classifications,
        const json::Value &classificationsPolicies,
        const json::Value &classificationsRules) noexcept(false);
    virtual void cb_sendClassificationContext(
        const json::Value &classifications) noexcept(false);
    virtual void cb_sendDocuments(const pybind11::object &documents) noexcept(
        false);
    virtual void cb_sendTagEndStream() noexcept(false);
    virtual void cb_sendTagEndObject() noexcept(false);
    virtual void cb_sendClose() noexcept(false);

    virtual int cb_addPermissions(py::dict &dict,
                                  bool throwOnError = false) noexcept(false);
    virtual bool cb_addUserGroupInfo(
        bool isUser, py::object &id, py::object &authority, py::object &name,
        py::object &local,
        py::object groupMembers = py::none()) noexcept(false);
    virtual bool cb_addUserInfo(py::object &id, py::object &authority,
                                py::object &name,
                                py::object &local) noexcept(false);
    virtual bool cb_addGroupInfo(
        py::object &id, py::object &authority, py::object &name,
        py::object &local,
        py::object groupMembers = py::none()) noexcept(false);

    //---------------------------------
    // Target mode functions
    //---------------------------------
    virtual bool cb_hasListener(std::string lane) noexcept(false);
    virtual std::vector<std::string> cb_getListeners() noexcept(false);
    virtual std::vector<std::string> cb_getControllerNodeIds(
        std::string &classType) noexcept(false);
    virtual void cb_control(std::string &filter, py::object &control,
                            std::string nodeId = "") noexcept(false);
    virtual void cb_open(py::object entry) noexcept(false);
    virtual void cb_writeTagBeginObject() noexcept(false);
    virtual void cb_writeTagBeginStream() noexcept(false);
    virtual void cb_writeTagData(py::object &data) noexcept(false);
    virtual void cb_writeTag(py::bytes data) noexcept(false);
    virtual void cb_writeText(const std::u16string &text) noexcept(false);
    virtual void cb_writeTable(const std::u16string &text) noexcept(false);
    virtual void cb_writeWords(const WordVector &textWords) noexcept(false);
    virtual void cb_writeJson(python::IJson json) noexcept(false);
    virtual void cb_writeAudio(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept(false);
    virtual void cb_writeVideo(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept(false);
    virtual void cb_writeImage(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept(false);
    virtual void cb_writeQuestions(const pybind11::object &question) noexcept(
        false);
    virtual void cb_writeAnswers(const pybind11::object &answers) noexcept(
        false);
    virtual void cb_writeClassifications(
        const json::Value &classifications,
        const json::Value &classificationPolicy,
        const json::Value &classificationRules) noexcept(false);
    virtual void cb_writeClassificationContext(
        const json::Value &classifications) noexcept(false);
    virtual void cb_writeDocuments(const pybind11::object &documents) noexcept(
        false);
    virtual void cb_writeTagEndStream() noexcept(false);
    virtual void cb_writeTagEndObject() noexcept(false);
    virtual void cb_close() noexcept(false);
    virtual void cb_closing() noexcept(false);

    //-----------------------------------------------------------------
    /// @details
    ///		Keeps track of all of our binding connections
    //-----------------------------------------------------------------
    Binder binder;

    //-----------------------------------------------------------------
    /// @details
    ///		Keeps track of all of our control/invoke interfaces
    //-----------------------------------------------------------------
    std::map<std::string, std::vector<int>> controller;

    //-----------------------------------------------------------------
    /// @details
    ///		Our endpoint. A link: set when the filter is made, and reset
    ///		only through releaseLinks(), under m_linkLock
    //-----------------------------------------------------------------
    ServiceEndpoint endpoint;

    //-----------------------------------------------------------------
    /// @details
    ///		Our global data. A link: set when the filter is made, and
    ///		reset only through releaseLinks(), under m_linkLock
    //-----------------------------------------------------------------
    ServiceGlobal global;

    //-----------------------------------------------------------------
    /// @details
    ///		Weak ptr to this
    //-----------------------------------------------------------------
    ServiceInstanceWeak instance;

    //-----------------------------------------------------------------
    /// @details
    ///		This is a ptr to the top pipe::IFilter. We need it to
    ///     store instance pipe specific event handlers. A link: set
    ///     when the stack is built, and reset only through
    ///     releaseLinks(), under m_linkLock
    //-----------------------------------------------------------------
    ServicePipe pipe;

    //-----------------------------------------------------------------
    /// @details
    ///		The next filter down the stack; empty for the last one. A
    ///		link: set when the stack is bound (bindLinkages()), and
    ///		reset only through releaseLinks(), under m_linkLock
    //-----------------------------------------------------------------
    ServiceInstance pDown;

    //-----------------------------------------------------------------
    /// @details
    ///		The logical type of filter
    //-----------------------------------------------------------------
    IPipeType pipeType;

    //-----------------------------------------------------------------
    /// @details
    ///		The currently opened enty
    //-----------------------------------------------------------------
    Entry *currentEntry = nullptr;

    //-----------------------------------------------------------------
    /// @details
    ///		Per-object stream_index counters for the stream descriptor
    ///		(stream_descriptor.hpp); reset in open(). Plain (non-atomic) is
    ///		safe: an instance is owned by one thread for its open->close
    ///		lifecycle (pooled via `busy`).
    //-----------------------------------------------------------------
    uint32_t videoStreamIndex = 0;
    uint32_t audioStreamIndex = 0;
    uint32_t imageStreamIndex = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		The entry Python opened on this filter (cb_open), kept so
    ///		Python does not free it while the object is open. A Python
    ///		reference: cb_close, the next cb_open and the destructor
    ///		release it under the GIL
    //-----------------------------------------------------------------
    py::object pyCurrentEntry;

    //-----------------------------------------------------------------
    /// @details
    ///		Pipe id - used for debugging
    //-----------------------------------------------------------------
    size_t pipeId = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		Filter level - used for debugging
    //-----------------------------------------------------------------
    size_t filterLevel = 0;

    //-----------------------------------------------------------------
    /// Indicates whether this pipe is available or not
    //-----------------------------------------------------------------
    bool busy = false;

    //-------------------------------------------------------------
    /// @details
    ///		Debugger support
    //-------------------------------------------------------------
    Debugger debugger;

    //-------------------------------------------------------------
    /// @details
    ///		Python-call gate.
    ///
    ///		Invariant: the links (endpoint, pipe, global, pDown) and
    ///		the buffers of a stack's filters are released only when no
    ///		Python call that passed the gate runs on any filter of that
    ///		stack: right after a full drain, or by the deferred release
    ///		below. In a stack whose filters were never linked to each
    ///		other (a pipe build that failed before its bind) this holds
    ///		per filter: the head is released when no call runs on the
    ///		head, and every other filter keeps its links until it is
    ///		freed. Once a filter's gate is closed, every new Python
    ///		call on it is refused. No filter object is freed while a
    ///		Python call into the engine runs on it.
    ///
    ///		A guard counts one Python call on a filter, or refuses it
    ///		once the filter's gate is closed. forwardTo()
    ///		(filter-handle.hpp) creates one before it calls a cb_*
    ///		callback; the handle members that read a link (next, pipe,
    ///		currentObject) and putPipe() create their own. The
    ///		callback and the binder code below it read the links,
    ///		which the invariant keeps valid while the call is counted.
    ///
    ///		Each side writes first and reads second, all seq_cst, so
    ///		at least one of them sees the other. On entry the guard
    ///		raises the count and then checks the gate, and teardown
    ///		closes the gate and then reads the count: either the guard
    ///		refuses or teardown waits for it. On leaving, the guard
    ///		drops the count and then reads the head's release flag,
    ///		and armDeferredRelease() sets the flag and then reads the
    ///		counts: a stack ended while a call ran is released once it
    ///		is idle. The guard holds the filter and the head until it
    ///		has left, so the last guard to leave can release the stack.
    ///
    ///		The full protocol:
    ///		docs/development/engine/python-call-lifetime.md
    //-------------------------------------------------------------
    class CallGuard {
    public:
        explicit CallGuard(ServiceInstance filter) noexcept(false);
        ~CallGuard() noexcept;

        CallGuard(const CallGuard &) = delete;
        CallGuard &operator=(const CallGuard &) = delete;

        /// The filter the call runs on
        const ServiceInstance &filter() const noexcept { return m_filter; }

        /// The head of the filter's stack, copied when the guard counted
        /// the call; never empty once the constructor has returned
        const ServicePipe &head() const noexcept { return m_head; }

    private:
        /// Drops the count, then releases the stack if it waits for this
        /// call
        void leave() noexcept;

        /// Both held until the guard has left: once the count has dropped,
        /// another thread may release the stack and reset the filter's own
        /// link to the head
        ServiceInstance m_filter;
        ServicePipe m_head;
    };

    /// True once the gate is closed: by closeGate() (teardown, or a pipe
    /// build that is not published), or by endFilterInstance(). The links
    /// may still be valid then.
    bool hasEnded() const noexcept {
        return m_ended.load(std::memory_order_seq_cst);
    }

    /// Refuses every new Python call on this filter from now on.
    /// endFilterInstance() sets the same flag; setting it twice is harmless.
    void closeGate() noexcept {
        m_ended.store(true, std::memory_order_seq_cst);
    }

    /// Number of Python calls counted by a CallGuard on this filter that
    /// have not left yet
    uint32_t callsInFlight() const noexcept {
        return m_inFlight.load(std::memory_order_seq_cst);
    }

    /// Makes the next endFilterInstance() run the filter's end hooks but keep
    /// endpoint, global, pipe and pDown (and the buffers) intact, because a
    /// Python call may still be running on this filter or on the binder
    /// chain below it. The links are released by releaseStackIfIdle() once
    /// no call runs on the stack, or by the destructor; the flag is consumed
    /// by the first call that sees it.
    void retainLinksOnEnd() noexcept {
        m_retainLinks.store(true, std::memory_order_release);
    }

    /// Arms the head filter for release on idle and releases the stack at once
    /// if it is already idle. Call after the stack's filters were ended.
    void armDeferredRelease() noexcept;

    /// Returns the next filter down the chain, copied under the link lock;
    /// empty if there is none or the links were released
    ServiceInstance downLink() const noexcept;

private:
    /// Drops endpoint, global, pipe and pDown and frees the buffers. Safe to
    /// call more than once.
    void releaseLinks() noexcept;

    /// On the head filter of a stack that was ended with its links retained:
    /// once no Python call runs on any filter of the stack, releases the links
    /// of every filter in it, exactly once. Does nothing when the stack was
    /// not armed or a call is still running. Returns the endpoint when it
    /// released the stack: the caller lets it go after the filters, so they
    /// are freed before their endpoint.
    ServiceEndpoint releaseStackIfIdle() noexcept;

    /// Returns the filter at the given index of this pipe's instance stack,
    /// read under the endpoint's stack lock; throws Ec::PipelineEnded if it
    /// no longer exists
    ServiceInstance stackFilter(size_t filterId) const noexcept(false);

    /// The gate is closed: set by closeGate() or endFilterInstance(), never
    /// cleared
    std::atomic<bool> m_ended{false};

    /// One-shot request that endFilterInstance() keeps the links
    std::atomic<bool> m_retainLinks{false};

    /// Set on the head filter (index 0) only: the stack is released by
    /// releaseStackIfIdle() when it becomes idle
    std::atomic<bool> m_releaseOnIdle{false};

    /// Python calls counted by a CallGuard on this filter that have not left
    /// yet
    std::atomic<uint32_t> m_inFlight{0};

    /// Held only while the links (endpoint, global, pipe and pDown) are
    /// copied or reset, never across a call into Python or a wait
    mutable std::mutex m_linkLock;

protected:

    //-----------------------------------------------------------------
    /// @details
    ///		Built in tag buffer allocated only when needed via the
    ///		allocateTagBuffer member
    //-----------------------------------------------------------------
    TAG *m_pTagBuffer = nullptr;

    //-----------------------------------------------------------------
    /// @details
    ///		Built in IO buffer allocated only when needed via the
    ///		allocateTagBuffer member
    //-----------------------------------------------------------------
    IOBuffer *m_pIOBuffer = nullptr;

    //-----------------------------------------------------------------
    /// @details
    ///		Contains the modified target path based on the
    ///		source path (generated by mapPath)
    //-----------------------------------------------------------------
    Url m_targetObjectUrl;

    //=================================================================
    // The following have been moved from the python instance class
    // to here so we can use them in both ILoader and
    // IPythonFilterBase
    //=================================================================

    //-----------------------------------------------------------------
    /// @details
    ///		Ptr to the target - set during renderObject
    //-----------------------------------------------------------------
    ServicePipe *m_pTarget = nullptr;

    //-----------------------------------------------------------------
    /// @details
    ///		Flag indicating if we have sent metadata yet
    //-----------------------------------------------------------------
    bool m_metadataWritten = false;

    //-----------------------------------------------------------------
    /// @details
    ///		The collected metadata
    //-----------------------------------------------------------------
    json::Value m_metadata;

    //-------------------------------------------------------------
    /// @details
    ///		Information about users.
    //-------------------------------------------------------------
    std::unordered_map<Text, perms::UserRecord> m_users;
    mutable async::SharedLock m_lockUsers;

    //-------------------------------------------------------------
    /// @details
    ///		Information about groups.
    //-------------------------------------------------------------
    std::unordered_map<Text, perms::GroupRecord> m_groups;
    mutable async::SharedLock m_lockGroups;

protected:
    void preprocessPermissions(Entry &object) noexcept;

    //-------------------------------------------------------------
    /// @details
    ///		Store the open mode during construction. This allows
    ///		us to log the destruction
    //-------------------------------------------------------------
    OPEN_MODE m_openMode;
};

//-------------------------------------------------------------------------
/// @details
///		This is the common class definition for a filter driver. A filter
///		contains two classes, the first, this one, contains the global
///		data shared among all instances of a filter
//-------------------------------------------------------------------------
class ROCKETRIDE_CORE_API IServiceFilterGlobal {
public:
    using Path = ap::file::Path;

    //-----------------------------------------------------------------
    // Delete copy constructor and copy assignment operator. If you
    // get compile errors, you need to figure out why you are copying
    //-----------------------------------------------------------------
    IServiceFilterGlobal(const IServiceFilterGlobal &) = delete;
    IServiceFilterGlobal &operator=(const IServiceFilterGlobal &) = delete;

    //-----------------------------------------------------------------
    // Delete move constructor and move assignment operator. If you
    // get compile errors, you need to figure out why you are moving
    //-----------------------------------------------------------------
    IServiceFilterGlobal(IServiceFilterGlobal &&) = delete;
    IServiceFilterGlobal &operator=(IServiceFilterGlobal &&) = delete;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::ServiceFilter;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory type
    //-----------------------------------------------------------------
    _const auto FactoryType = "iFilterGlobal";
    // Interfaces derived from this class share its factory registry, and every
    // method stored in it returns a pointer to this root
    using FactoryRoot = IServiceFilterGlobal;

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << m_openMode << " "
             << "[G]";
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Factory args
    //-----------------------------------------------------------------
    struct FactoryArgs {
        IPipeType pipeType;
        ServiceEndpoint &endpoint;
    };

    //-----------------------------------------------------------------
    /// @details
    ///		Static factory hook to create the appropriate type
    //-----------------------------------------------------------------
    static ErrorOr<ServiceGlobalPtr> __factory(Location location,
                                               uint32_t requiredFlags,
                                               FactoryArgs args) noexcept {
        // Instantiate it
        return Factory::find<IServiceFilterGlobal>(
            location, requiredFlags, args.pipeType.physicalType, args);
    }

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    virtual ~IServiceFilterGlobal();
    IServiceFilterGlobal(const FactoryArgs &args) noexcept
        : pipeType(args.pipeType), endpoint(args.endpoint) {
        m_openMode = endpoint->config.openMode;
        LOGPIPE();
    };

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginFilterGlobal() noexcept;
    virtual Error endFilterGlobal() noexcept;

    virtual Error validateConfig() noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Our endpoint
    //-----------------------------------------------------------------
    ServiceEndpoint endpoint;

    //-----------------------------------------------------------------
    /// @details
    ///		Weak ptr to this
    //-----------------------------------------------------------------
    ServiceGlobalWeak global;

    //-----------------------------------------------------------------
    /// @details
    ///		The logical/phyiscal type of this filter
    //-----------------------------------------------------------------
    IPipeType pipeType;

protected:
    //-------------------------------------------------------------
    /// @details
    ///		Store the open mode during construction. This allows
    ///		us to log the destruction
    //-------------------------------------------------------------
    OPEN_MODE m_openMode;
};
}  // namespace engine::store
