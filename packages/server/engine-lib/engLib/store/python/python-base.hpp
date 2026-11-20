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
//	The class definition for Windows file system node
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store::pythonBase {
namespace py = pybind11;
using namespace pybind11::literals;

class IPythonGlobalBase;
class IPythonInstanceBase;

//-------------------------------------------------------------------------
/// @details
///		Defines flags for optional API pipe methods, indicating whether
///     the method is implemented by the underlying python node or not
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM_BITMASK(
    PythonInstanceMethod, 0, 25, None = 0,

    BeginInstance = BIT(0), EndInstance = BIT(1),

    CheckChanged = BIT(2), Control = BIT(3), Open = BIT(4), Closing = BIT(5),
    Close = BIT(6),

    WriteTag = BIT(7), WriteText = BIT(8), WriteTable = BIT(9),
    WriteWords = BIT(10), WriteAudio = BIT(11), WriteVideo = BIT(12),
    WriteImage = BIT(13), WriteQuestions = BIT(14), WriteAnswers = BIT(15),
    WriteClassifications = BIT(16), WriteClassificationContext = BIT(17),
    WriteDocuments = BIT(18),

    GetPermissions = BIT(19), OutputPermissions = BIT(20),
    GetPermissionsBulk = BIT(21), GetThreadCount = BIT(22),

    WriteJson = BIT(23));

//-------------------------------------------------------------------------
/// @details
///		Define the endpoint
//-------------------------------------------------------------------------
class IPythonEndpointBase : public IServiceEndpoint {
public:
    using Config = IServiceConfig;
    using Parent = IServiceEndpoint;
    using Parent::Parent;

    friend IPythonGlobalBase;
    friend IPythonInstanceBase;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::Python;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IPythonEndpointBase(const FactoryArgs &args) noexcept;
    virtual ~IPythonEndpointBase() noexcept;

    //-----------------------------------------------------------------
    // Public API	: python-endpoint.cpp
    //		Controls starting/stopping the endpoint
    //-----------------------------------------------------------------
    virtual Error beginEndpoint(OPEN_MODE openMode) noexcept override;
    virtual Error signal(const Text &signal,
                         json::Value &param) noexcept override;
    virtual Error endEndpoint() noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-endpoint.config.cpp
    //		Configuration and validation
    //-----------------------------------------------------------------
    virtual Error getConfigSubKey(Text &key) noexcept override;
    virtual Error validateConfig(bool syntaxOnly) noexcept override;
    virtual Error getPipeFilters(IPipeFilters &filters) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-endpoint.source.cpp
    // 		Source endpoint support
    //-----------------------------------------------------------------
    virtual Error scanObjects(Path &path,
                              const ScanAddObject &callback) noexcept override;

private:
    //-------------------------------------------------------------
    /// @details
    ///		Handle to our module object
    //-------------------------------------------------------------
    py::object m_pyModule;

    //-------------------------------------------------------------
    /// @details
    ///		Handle to our python IEndpoint object
    //-------------------------------------------------------------
    py::object m_pyEndpoint;

    //-------------------------------------------------------------
    /// @details
    ///        The result of binding python objects to handles.
    //-------------------------------------------------------------
    Error m_boundError;
};

//-------------------------------------------------------------------------
/// @details
///		A control's IGlobal on a node is ended and dropped by the engine's
///		idle sweep once no binding has touched it for this long (plan 4.1
///		rule 1, 15 minutes). The next open rebuilds it from its config
//-------------------------------------------------------------------------
_const int CONST_IGLOBAL_IDLE_SECONDS = 900;

//-------------------------------------------------------------------------
/// @details
///		How often the engine-wide sweep runs over every node's controls
//-------------------------------------------------------------------------
_const int CONST_IGLOBAL_SWEEP_SECONDS = 60;

//-------------------------------------------------------------------------
/// @details
///		What rocketlib reads as IGlobal.glb: one control's view of the
///		node. The node is one C++ global; the configuration is the
///		control's (the resolved config that rode its open, plan 5.3), so
///		every IGlobal object carries its own copy of this. The identity
///		fields fill the reserved `config.node` record (plan 5.6.4: id,
///		name, provider = logicalType, physicalType, capabilities,
///		controlId); connConfig is an OWNED python dict built once at slot
///		build, never a view into engine memory, so a reference a node
///		keeps past the idle sweep stays valid
//-------------------------------------------------------------------------
struct GlobalContext {
    Text controlId;
    Text id;
    Text name;
    Text logicalType;
    Text physicalType;
    uint32_t capabilities = 0;
    py::object connConfig;
};

//-------------------------------------------------------------------------
/// @details
///		Define the common class for this filter.
///
///		One C++ global per node; one Python IGlobal per CONTROL on it
///		(plan 4.1 rule 1). The IGlobals live in a map keyed by the control
///		id and are built LAZILY: the first binding that touches the node
///		under a control (the binder's first touch, beginBinding) builds
///		the slot under its own lock - construct, inject IEndpoint and the
///		control's glb, beginGlobal() - so concurrent bindings of one
///		control wait on that lock and different controls never wait on
///		each other. Every binding touches its slot when it binds and when
///		it releases; the engine-wide sweep (one thread, every
///		CONST_IGLOBAL_SWEEP_SECONDS) ends and erases a slot idle longer
///		than CONST_IGLOBAL_IDLE_SECONDS with no open binding. Nothing
///		per control is built at launch: beginGlobal runs when a control's
///		open arrives. A binding without a caller (C++-driven work: a scan
///		source, a test) binds the default slot, keyed by the empty id and
///		configured from the task file.
//-------------------------------------------------------------------------
class IPythonGlobalBase : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;
    using Clock = std::chrono::steady_clock;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::Python;

    //-----------------------------------------------------------------
    ///	@details
    ///		Allow the filter instance to see our private data. We can
    ///		either make it public, or limit the scope to
    ///		IPythonInstanceBase
    //-----------------------------------------------------------------
    friend IPythonInstanceBase;

    //-----------------------------------------------------------------
    /// @details
    ///		One control's IGlobal on this node
    //-----------------------------------------------------------------
    struct GlobalSlot {
        //---------------------------------------------------------
        /// The node's IGlobal object for this control; empty until
        /// built
        //---------------------------------------------------------
        py::object global;

        //---------------------------------------------------------
        /// Serializes the build, the end and every binding's claim
        /// of this slot. Taken with the GIL RELEASED, so a waiter
        /// never holds the interpreter while the builder needs it
        //---------------------------------------------------------
        std::mutex lock;

        //---------------------------------------------------------
        /// When a binding last bound or released this slot. Atomic:
        /// releaseSlot writes it with no lock held and the sweep's
        /// candidate scan reads it under the map lock
        //---------------------------------------------------------
        std::atomic<Clock::time_point> lastTouch{Clock::now()};

        //---------------------------------------------------------
        /// beginGlobal() has run. Atomic: written under the slot
        /// lock, read under the map lock by controlIds() and the
        /// sweep's candidate scan
        //---------------------------------------------------------
        std::atomic<bool> built{false};

        //---------------------------------------------------------
        /// Ended by the sweep or the endpoint: no longer in the
        /// map, never served again. A waiter that wakes on a
        /// retired slot goes back to the map for a fresh one
        //---------------------------------------------------------
        bool retired = false;

        //---------------------------------------------------------
        /// Open bindings holding this slot: the sweep skips a slot
        /// with any
        //---------------------------------------------------------
        std::atomic<int> bindings{0};
    };
    using SlotPtr = std::shared_ptr<GlobalSlot>;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IPythonGlobalBase(const FactoryArgs &args) noexcept;
    virtual ~IPythonGlobalBase() noexcept;

    //-----------------------------------------------------------------
    // Public API	: python-global.cpp
    //-----------------------------------------------------------------
    virtual Error beginFilterGlobal() noexcept override;
    virtual Error endFilterGlobal() noexcept override;

    virtual Error validateConfig() noexcept override;

    //-----------------------------------------------------------------
    /// @details
    ///		Bind a binding to the IGlobal of its control: the control is
    ///		`caller['controlId']` (none = the default slot) and, when the
    ///		slot is not built yet, `caller['config'][stackIndex]` is its
    ///		configuration (the open carries it; write/close/tool carry
    ///		the id alone and find the slot the open built). Builds the
    ///		slot on the first touch under its lock, counts the binding
    ///		and touches it. Must be called with the GIL held; it releases
    ///		the GIL while it waits for the slot
    ///	@param[in]	caller
    ///		The binding's caller context (pipe->caller), or none
    ///	@returns
    ///		The slot the binding holds until releaseSlot()
    //-----------------------------------------------------------------
    ErrorOr<SlotPtr> acquireSlot(const py::object &caller) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Release a binding's hold on its slot and touch it
    //-----------------------------------------------------------------
    void releaseSlot(SlotPtr &slot) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		The engine-wide sweep: on every node, end (endGlobal) and
    ///		erase each control's slot that no binding holds and that was
    ///		last touched longer than `idle` ago. The sweep thread calls
    ///		this with CONST_IGLOBAL_IDLE_SECONDS; a test may call it with
    ///		any threshold. An endGlobal that raises is logged to OPS and
    ///		the slot is erased anyway
    //-----------------------------------------------------------------
    static void sweepIdleGlobals(std::chrono::seconds idle) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		The controls holding an IGlobal on this node right now
    //-----------------------------------------------------------------
    std::vector<Text> controlIds() noexcept;

private:
    //-----------------------------------------------------------------
    // Private API	: python-global.cpp
    //-----------------------------------------------------------------
    Error buildSlot(GlobalSlot &slot, const Text &controlId,
                    json::Value connConfig) noexcept;
    Error endSlot(GlobalSlot &slot) noexcept;
    void sweepIdle(Clock::time_point before) noexcept;
    Opt<size_t> stackIndex() noexcept;
    Text componentName() noexcept;
    GlobalContext makeContext(const Text &controlId,
                              const json::Value &connConfig);
    static void sweepProcess() noexcept;

    //-------------------------------------------------------------
    /// @details
    ///		The node package (serviceDef.nodePath or the logical type)
    ///		whose IGlobal/IValidator/IInstance files are imported as
    ///		submodules by name
    //-------------------------------------------------------------
    Text m_modulePath;

    //-------------------------------------------------------------
    /// @details
    ///		The factory kind the node was built with (the service
    ///		definition's `node`, "python"), resolved ONCE at
    ///		construction while the service is visible (a custom
    ///		service is only inside the starter's withCustomServices
    ///		scope); config.node.physicalType of every control. Empty
    ///		when the definition had none: then the stack's own
    ///		physicalType stands in
    //-------------------------------------------------------------
    Text m_physicalType;

    //-------------------------------------------------------------
    /// @details
    ///		Handle to the imported <path>.IGlobal (or, in config mode,
    ///		<path>.IValidator) submodule - empty when the file is absent
    //-------------------------------------------------------------
    py::object m_pyModule;

    //-------------------------------------------------------------
    /// @details
    ///		The IGlobal class every control's object is constructed
    ///		from: the node's own, or rocketlib.IGlobalBase when the node
    ///		ships no IGlobal.py
    //-------------------------------------------------------------
    py::object m_pyGlobalClass;

    //-------------------------------------------------------------
    /// @details
    ///		Handle to our python IEndpoint object
    //-------------------------------------------------------------
    py::object m_pyEndpoint;

    //-------------------------------------------------------------
    /// @details
    ///		CONFIG / PIPELINE_CONFIG mode only: the IValidator (the
    ///		node's own, or rocketlib.IValidatorBase) that validateConfig
    ///		runs. No control exists in config mode, so no slot does
    //-------------------------------------------------------------
    py::object m_pyValidator;

    //-------------------------------------------------------------
    /// @details
    ///		The per-control IGlobals, keyed by control id ("" = the
    ///		default slot of a binding without a caller). Guarded by
    ///		m_slotsLock, which is never held across a Python call
    //-------------------------------------------------------------
    std::map<std::string, SlotPtr> m_slots;
    std::mutex m_slotsLock;

    //-------------------------------------------------------------
    /// @details
    ///		This node's position in the task file's component list -
    ///		the index `caller['config']` is addressed by. None for a
    ///		node the open's config list does not address (a filter the
    ///		pipeline did not declare): such a node runs on its own
    ///		connConfig and never takes another component's by position
    //-------------------------------------------------------------
    Opt<size_t> m_stackIndex;

    //-------------------------------------------------------------
    /// @details
    ///        The result of binding python objects to handles.
    //-------------------------------------------------------------
    Error m_boundError;

    //-------------------------------------------------------------
    /// @details
    ///		How many sweeps hold this global right now. Guarded by
    ///		s_registryLock: the sweep pins every global it snapshots
    ///		before it lets the registry lock go, and the destructor
    ///		waits on s_registryIdle until no sweep holds it
    //-------------------------------------------------------------
    int m_sweepHold = 0;

    //-------------------------------------------------------------
    /// @details
    ///		Every live node global, for the engine-wide sweep, and the
    ///		one sweep thread: started with the first global, stopped
    ///		with the last. The sweep never calls into Python with the
    ///		registry lock held (a node's endGlobal may construct or
    ///		destroy a global of its own); it pins the globals instead
    //-------------------------------------------------------------
    static std::mutex s_registryLock;
    static std::condition_variable s_registryIdle;
    static std::set<IPythonGlobalBase *> s_registry;
    static Opt<async::Thread> s_sweeper;
};

//-------------------------------------------------------------------------
/// @details
///		Define the instance class for this filter
//-------------------------------------------------------------------------
class IPythonInstanceBase : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;
    using PythonMethod = PythonInstanceMethod;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::Python;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IPythonInstanceBase(const FactoryArgs &args) noexcept;
    virtual ~IPythonInstanceBase();

    //-----------------------------------------------------------------
    // Public API	: python-instance.cpp
    //-----------------------------------------------------------------
    virtual Error beginFilterInstance() noexcept override;
    virtual Error endFilterInstance() noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.source.cpp
    //		Source mode support
    //-----------------------------------------------------------------
    virtual uint32_t getThreadCount(
        uint32_t currentThreadCount) const noexcept override;
    virtual ErrorOr<bool> stat(Entry &entry) noexcept override;
    virtual Error checkChanged(Entry &object) noexcept override;
    virtual Error removeObject(Entry &object) noexcept override;
    virtual Error renderObject(ServicePipe &target,
                               Entry &object) noexcept override;

    //----------------------------------------------------------------
    // Public API	: python-instance.permissions.cpp
    //		Permissions support
    //-----------------------------------------------------------------
    virtual Error getPermissions(Entry &entry) noexcept override;
    virtual ErrorOr<size_t> getPermissions(
        std::vector<Entry> &entries) noexcept override;
    virtual ErrorOr<std::list<Text>> outputPermissions() noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.target.cpp
    //		Supports target mode open/close
    //-----------------------------------------------------------------
    virtual Error control(py::object &control) noexcept override;
    virtual Error open(Entry &object) noexcept override;
    virtual Error closing() noexcept override;
    virtual Error close() noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.data.cpp
    //		Supports tag/data lanes
    //-----------------------------------------------------------------
    virtual Error writeTag(const TAG *pTag) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.text.cpp
    //		Supports text lane
    //-----------------------------------------------------------------
    virtual Error writeText(const Utf16View &text) noexcept override;
    virtual Error writeTable(const Utf16View &text) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.words.cpp
    //		Supports word lane
    //-----------------------------------------------------------------
    virtual Error writeWords(const WordVector &textWords) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.json.cpp
    //		Supports json lane
    //-----------------------------------------------------------------
    virtual Error writeJson(const json::Value &jsonData) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.avi.cpp
    //		Supports avi lanes
    //-----------------------------------------------------------------
    virtual Error writeAudio(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override;
    virtual Error writeVideo(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override;
    virtual Error writeImage(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.classification.cpp
    //		Supports the classification lane
    //-----------------------------------------------------------------
    virtual Error writeClassifications(
        const json::Value &classifications,
        const json::Value &classificationPolicy,
        const json::Value &classificationRules) noexcept override;
    virtual Error writeClassificationContext(
        const json::Value &classifications) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.question.cpp
    //		Supports the question/answer lane
    //-----------------------------------------------------------------
    virtual Error writeQuestions(
        const pybind11::object &question) noexcept override;
    virtual Error writeAnswers(
        const pybind11::object &answers) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.documents.cpp
    //		Supports documents lane
    //-----------------------------------------------------------------
    virtual Error writeDocuments(
        const pybind11::object &documents) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: Utilities
    //-----------------------------------------------------------------
    //-----------------------------------------------------------------
    /// @details
    ///		The node's IInstance for the CURRENT binding, constructed on
    ///		first use (plan 4.1 rule 2). Throws the bind error, so a
    ///		caller inside callPython sees it as the call's error. Must be
    ///		called with the GIL held
    //-----------------------------------------------------------------
    py::object &boundInstance();

    //-----------------------------------------------------------------
    /// @details
    ///		The instance as built: none while this binding has not
    ///		touched the node
    //-----------------------------------------------------------------
    py::object getPythonInstance() const noexcept { return m_pyInstance; }

    //-----------------------------------------------------------------
    // Binding lifetime - python-instance.cpp
    //-----------------------------------------------------------------
    virtual Error beginBinding() noexcept override;
    virtual Error endBinding() noexcept override;
    const Url &getTargetObjectUrl() const noexcept { return m_targetObjectUrl; }
    const Text &getTargetObjectPath() const noexcept {
        return m_targetObjectPath;
    }

private:
    //-------------------------------------------------------------
    // Reference to the bound global
    //-------------------------------------------------------------
    IPythonGlobalBase &m_global;

    //-------------------------------------------------------------
    // Reference to the bound pipe
    //-------------------------------------------------------------
    IPythonEndpointBase &m_endpoint;

    //-------------------------------------------------------------
    /// @details
    ///		The node's IInstance class, probed once when the filter is
    ///		built; instances are constructed from it per binding
    //-------------------------------------------------------------
    py::object m_pyInstanceClass;

    //-------------------------------------------------------------
    /// @details
    ///		Handle to the IInstance object of the CURRENT binding; none
    ///		between bindings
    //-------------------------------------------------------------
    py::object m_pyInstance;

    //-------------------------------------------------------------
    /// @details
    ///		The control's IGlobal slot the current binding holds on the
    ///		global (plan 4.1 rule 1); released with the binding
    //-------------------------------------------------------------
    IPythonGlobalBase::SlotPtr m_slot;

    //-------------------------------------------------------------
    /// @details
    ///		The list of the optional methods that the driver have.
    //-------------------------------------------------------------
    PythonMethod m_pyMethods{};

    //-------------------------------------------------------------
    /// @details
    ///		Path to current target object to upload.
    //-------------------------------------------------------------
    Text m_targetObjectPath;

    //-------------------------------------------------------------
    /// @details
    ///        The result of binding python objects to handles.
    //-------------------------------------------------------------
    Error m_boundError;
};
}  // namespace engine::store::pythonBase
