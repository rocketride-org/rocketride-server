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

namespace engine::store::pythonBase {
//-------------------------------------------------------------------------
/// @details
///		The registry of live node globals the engine-wide sweep walks, and
///		the one sweep thread
//-------------------------------------------------------------------------
std::mutex IPythonGlobalBase::s_registryLock;
std::condition_variable IPythonGlobalBase::s_registryIdle;
std::set<IPythonGlobalBase *> IPythonGlobalBase::s_registry;
Opt<async::Thread> IPythonGlobalBase::s_sweeper;

//-------------------------------------------------------------------------
/// @details
///		Imports <path>.<name> from the node package. The file is optional:
///		an absent file returns an empty handle, while a file that fails
///		to import is an error.
///	@param[in]	path
///		The node package, e.g. nodes.store_qdrant
///	@param[in]	name
///		The submodule file name without extension, e.g. IGlobal
//-------------------------------------------------------------------------
static ErrorOr<py::object> loadOptionalSubmodule(const Text &path,
                                                 const char *name) noexcept {
    py::object pyModule;

    const auto python = localfcn()->Error {
        const Text moduleName = _ts(path, ".", name);

        // find_spec imports the parent package only, so an absent file costs
        // nothing more than the (empty) package __init__
        auto pyUtil = py::module_::import("importlib.util");
        if (pyUtil.attr("find_spec")(moduleName).is_none()) return {};

        pyModule = py::module_::import(moduleName);
        return {};
    };

    if (auto ccode = callPython(python)) return ccode;

    return pyModule;
}

//-------------------------------------------------------------------------
/// @details
///		Constructor - resolves the node package and the class every
///		control's IGlobal is built from. The node package contract is
///		file-per-class: <path>.IGlobal is imported when the pipe runs
///		(falling back to rocketlib.IGlobalBase, so an instance's settings
///		resolve for a node that ships only IInstance.py), and in CONFIG /
///		PIPELINE_CONFIG mode only <path>.IValidator (falling back to
///		rocketlib.IValidatorBase) - IGlobal.py is never imported there.
///		No IGlobal object is constructed here: each control's is built on
///		the first binding that touches the node under it (acquireSlot)
//-------------------------------------------------------------------------
IPythonGlobalBase::IPythonGlobalBase(const FactoryArgs &args) noexcept
    : Parent(args) {
    // Define this so we can set a breakpoint if we need to
    auto python = localfcn()->Error {
        // Get our service definition
        auto service = IServices::getServiceDefinition(pipeType.logicalType);
        if (!service) return service.ccode();
        const auto &serviceDef = **service;

        // Determine the package to import from serviceDef.nodePath, if
        // specified, or from pipeType.logicalType - otherwise
        auto servicePath = serviceDef.nodePath
                               ? _cast<TextView>(serviceDef.nodePath)
                               : _cast<TextView>(pipeType.logicalType);
        m_modulePath = _ts(servicePath);

        // Are we supporting our endpoint?
        if (endpoint->pipeType.logicalType == pipeType.logicalType &&
            endpoint->pipeType.physicalType == pipeType.physicalType) {
            // Since the log/phy names are the same, we know this is a python
            // endpoint
            auto &pythonEndpoint =
                static_cast<IPythonEndpointBase &>(*endpoint);

            // Yes we are, so use the endpoints python IEndpoint
            m_pyEndpoint = pythonEndpoint.m_pyEndpoint;
        } else {
            // Load our util module so we can setup a dummy IEndpoint
            Text utilName = "rocketlib";
            auto pyUtil = engine::python::loadModule(utilName);
            if (!pyUtil) return pyUtil.ccode();

            // Get the module
            auto pyUtilModule = *pyUtil;

            // Check it
            if (!py::hasattr(pyUtilModule, "IEndpointBase"))
                return APERR(Ec::InvalidModule,
                             "The IEndpointBase template is missing");

            // Create the wrapper endpoint
            m_pyEndpoint = pyUtilModule.attr("IEndpointBase")();

            // Save the physical endpoint into the endpoint key
            m_pyEndpoint.attr("endpoint") =
                py::cast(static_cast<IServiceEndpoint *>(endpoint.get()));
        }

        // Config mode validates: import the validator, never the global
        const bool configMode = m_openMode == OPEN_MODE::CONFIG ||
                                m_openMode == OPEN_MODE::PIPELINE_CONFIG;
        const char *className = configMode ? "IValidator" : "IGlobal";

        // Import <path>.IGlobal / <path>.IValidator - both are optional
        auto pyModule = loadOptionalSubmodule(m_modulePath, className);
        if (!pyModule) return pyModule.ccode();
        m_pyModule = *pyModule;

        // The class every object is constructed from
        py::object pyClass;
        if (m_pyModule) {
            // The file is present, so the class is not optional
            if (!py::hasattr(m_pyModule, className))
                return APERR(Ec::InvalidModule, "Class", className,
                             "is missing from", _ts(m_modulePath, ".",
                                                    className));

            pyClass = m_pyModule.attr(className);
        } else {
            // No IValidator.py / IGlobal.py: the framework default. The
            // validator checks the configuration against the schema; the
            // global resolves it, so an instance's settings work for a
            // node that ships only IInstance.py
            const char *baseName =
                configMode ? "IValidatorBase" : "IGlobalBase";
            Text utilName = "rocketlib";
            auto pyUtil = engine::python::loadModule(utilName);
            if (!pyUtil) return pyUtil.ccode();

            if (!py::hasattr(*pyUtil, baseName))
                return APERR(Ec::InvalidModule, "The", baseName,
                             "template is missing");

            pyClass = pyUtil->attr(baseName);
        }

        if (configMode) {
            // No control exists in config mode: the one validator reads the
            // task file's configuration through the same glb an IGlobal does
            m_pyValidator = pyClass();
            m_pyValidator.attr("IEndpoint") = m_pyEndpoint;
            m_pyValidator.attr("glb") =
                py::cast(makeContext({}, pipeType.connConfig));
            return {};
        }

        // The IGlobal class: one object per control, built on first touch
        m_pyGlobalClass = pyClass;

        // Where this node's configuration sits in the open's config list:
        // the task file's component order, which is what the server wrote
        // and reads back (plan 5.3). Outside a pipeline (a filter stack
        // named by type) it is the stack position
        m_stackIndex = stackIndex();
        return {};
    };

    m_boundError = callPython(python);

    // Config mode has nothing to sweep; a pipe-mode node joins the sweep
    if (!m_boundError && m_pyGlobalClass) {
        std::lock_guard<std::mutex> guard(s_registryLock);

        s_registry.insert(this);

        // The first live global starts the one sweep thread. A thread
        // that did not start is not kept: the next global tries again,
        // and the ops stream hears why (>ERR)
        if (!s_sweeper) {
            s_sweeper.emplace(_location, "IGlobalSweep",
                              &IPythonGlobalBase::sweepProcess);
            if (auto ccode = s_sweeper->start()) {
                s_sweeper.reset();
                if (::engine::config::monitor())
                    ::engine::config::monitor()->error(APERR(
                        ccode, "The IGlobal sweep thread did not start"));
            }
        }
    }
}

//-------------------------------------------------------------------------
/// @details
///		Destructor - leaves the sweep (stopping the sweep thread with the
///		last global, outside the registry lock the thread itself takes)
///		and drops the Python handles under the GIL. The slots were ended
///		by endFilterGlobal; whatever is still here is released without
///		calling into the node
//-------------------------------------------------------------------------
IPythonGlobalBase::~IPythonGlobalBase() noexcept {
    // Leave the registry once no sweep holds us (a sweep that snapshotted
    // us may still be in our sweepIdle); take the thread with us when we
    // were the last
    Opt<async::Thread> retire;
    _block() {
        std::unique_lock<std::mutex> guard(s_registryLock);

        s_registryIdle.wait(guard, [this] { return m_sweepHold == 0; });
        s_registry.erase(this);
        if (s_registry.empty()) {
            retire = _mv(s_sweeper);
            s_sweeper.reset();
        }
    }
    retire.reset();

    // Clean up python side
    _block() {
        engine::python::LockPython lock;

        _block() {
            std::lock_guard<std::mutex> guard(m_slotsLock);
            m_slots.clear();
        }
        m_pyValidator = {};
        m_pyGlobalClass = {};
        m_pyEndpoint = {};
        m_pyModule = {};
    }
}

//-------------------------------------------------------------------------
/// @details
///		This node's index in the task file's component list - the index
///		the open's `config` list is addressed by (plan 5.3; the component
///		order _build_task wrote). A node the component list does not
///		name (a filter a node inserted while it began) has no index: the
///		open's list carries nothing for it, so it runs on its own
///		connConfig rather than on another component's by position. A
///		stack built without a pipeline (a filter stack named by type)
///		uses the stack position
//-------------------------------------------------------------------------
Opt<size_t> IPythonGlobalBase::stackIndex() noexcept {
    // Step 1: the pipeline's component order, when there is one
    auto &components = endpoint->config.pipeline.components();
    if (components.isArray()) {
        for (json::Value::ArrayIndex i = 0; i < components.size(); ++i)
            if (components[i].isObject() &&
                components[i].lookup<Text>("id", "") == pipeType.id)
                return i;
        return {};
    }

    // Step 2: otherwise the position in the endpoint's stack
    for (size_t i = 0; i < endpoint->pipeStack.size(); ++i)
        if (endpoint->pipeStack[i].id == pipeType.id) return i;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		The author's display name for this node: the task-file component
///		entry's `name`, else the component id (what the server labels a
///		node by). A stack built without a pipeline has only the id
//-------------------------------------------------------------------------
Text IPythonGlobalBase::componentName() noexcept {
    auto &components = endpoint->config.pipeline.components();
    if (components.isArray()) {
        for (json::Value::ArrayIndex i = 0; i < components.size(); ++i) {
            if (!components[i].isObject() ||
                components[i].lookup<Text>("id", "") != pipeType.id)
                continue;
            auto name = components[i].lookup<Text>("name", "");
            return name.empty() ? pipeType.id : name;
        }
    }
    return pipeType.id;
}

//-------------------------------------------------------------------------
/// @details
///		One control's view of this node, as rocketlib reads it through
///		glb: the identity the reserved `config.node` record carries
///		(plan 5.6.4) and an OWNED python copy of the control's
///		configuration. Nothing in it points into engine memory, so a
///		reference a node keeps past the idle sweep stays valid. Called
///		with the GIL held.
///
///		physicalType is the FACTORY the engine built the node with, the
///		service definition's `node` ("python" here), as config.node
///		documents it; the pipe stack's physicalType is the name the
///		node's factory is registered under (its provider), which is not
///		that
//-------------------------------------------------------------------------
GlobalContext IPythonGlobalBase::makeContext(const Text &controlId,
                                            const json::Value &connConfig) {
    // Step 1: the factory kind from the service definition, else the stack's
    Text physicalType = pipeType.physicalType;
    auto service = IServices::getServiceDefinition(pipeType.logicalType);
    if (service && (*service)->physicalType)
        physicalType = _ts(_cast<TextView>((*service)->physicalType));

    // Step 2: the record, every field an owned copy
    return GlobalContext{controlId,
                         pipeType.id,
                         componentName(),
                         pipeType.logicalType,
                         physicalType,
                         pipeType.capabilities,
                         engine::python::pyjson::jsonToDict(connConfig)};
}

//-------------------------------------------------------------------------
/// @details
///		Nothing per control is begun with the endpoint: a control's
///		IGlobal is built by the first binding under it (acquireSlot)
//-------------------------------------------------------------------------
Error IPythonGlobalBase::beginFilterGlobal() noexcept {
    LOGPIPE();

    if (m_boundError) return m_boundError;

    return Parent::beginFilterGlobal();
};

//-------------------------------------------------------------------------
/// @details
///		Ends every control's IGlobal still on this node (endGlobal) and
///		releases the Python handles. A node whose endGlobal fails is
///		reported after every slot had its turn
//-------------------------------------------------------------------------
Error IPythonGlobalBase::endFilterGlobal() noexcept {
    LOGPIPE();

    if (m_boundError) return m_boundError;

    // Take every slot out of the map: nothing can find one from here on
    std::map<std::string, SlotPtr> slots;
    _block() {
        std::lock_guard<std::mutex> guard(m_slotsLock);
        slots.swap(m_slots);
    }

    // End them one by one, each under its own lock
    Error ccode;
    for (auto &[controlId, slot] : slots) {
        std::lock_guard<std::mutex> guard(slot->lock);

        slot->retired = true;
        ccode = endSlot(*slot) || ccode;
    }

    // Release the endpoint, the class and the module
    _block() {
        engine::python::LockPython lock;

        m_pyEndpoint = {};
        m_pyGlobalClass = {};
        m_pyValidator = {};
        m_pyModule = {};
    }

    return checkCallParent(ccode) ? Parent::endFilterGlobal() : ccode;
};

//-------------------------------------------------------------------------
/// @details
///		Config mode: run the node's IValidator over the task file's
///		configuration
//-------------------------------------------------------------------------
Error IPythonGlobalBase::validateConfig() noexcept {
    LOGPIPE();

    if (m_boundError) return m_boundError;

    const auto python = localfcn()->Error {
        // If we have an IValidator
        if (m_pyValidator) {
            if (py::hasattr(m_pyValidator, "validateConfig"))
                m_pyValidator.attr("validateConfig")();
        }
        return {};
    };

    auto ccode = callPython(python);

    return checkCallParent(ccode) ? Parent::validateConfig() : ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Build one control's IGlobal: construct it from the node's class,
///		inject IEndpoint and the control's glb (its id and configuration),
///		run beginGlobal(). Called with the GIL held and the slot locked.
///		A build that fails leaves no object behind
//-------------------------------------------------------------------------
Error IPythonGlobalBase::buildSlot(GlobalSlot &slot, const Text &controlId,
                                   json::Value connConfig) noexcept {
    // The control's config arrives as the pipeline stores it: a secret leaf
    // rides its `secureParameters` token (plan 12 F). The task-file launch
    // decoded it with the deployment secret before any node ran
    // (Pipeline.cpp, PipelineConfig::decrypt); the same decode runs here,
    // so the node reads plaintext exactly as it did from the task file
    if (auto ccode = pipeline::PipelineConfig::decryptSection(connConfig))
        return APERR(ccode, "Control", controlId, "config of", pipeType.id,
                     ccode.message());

    const auto python = localfcn()->Error {
        // Create the IGlobal of this control
        slot.global = m_pyGlobalClass();

        // Initialize it with the host endpoint
        slot.global.attr("IEndpoint") = m_pyEndpoint;

        // The control's view of the node: rocketlib resolves self.config
        // from glb.connConfig, the control's configuration as an owned copy
        slot.global.attr("glb") = py::cast(makeContext(controlId, connConfig));

        // Begin it
        if (py::hasattr(slot.global, "beginGlobal"))
            slot.global.attr("beginGlobal")();
        return {};
    };

    if (auto ccode = callPython(python)) {
        slot.global = {};
        return ccode;
    }

    slot.built = true;
    LOG(Python, "Built the IGlobal of control", controlId, "on", pipeType.id);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		End one control's IGlobal: endGlobal() when it was begun, then the
///		object is dropped under the GIL. Called with the slot locked
//-------------------------------------------------------------------------
Error IPythonGlobalBase::endSlot(GlobalSlot &slot) noexcept {
    Error ccode;

    if (slot.built) {
        const auto python = localfcn()->Error {
            if (py::hasattr(slot.global, "endGlobal"))
                slot.global.attr("endGlobal")();
            return {};
        };

        ccode = callPython(python);
    }

    // The object goes whether or not endGlobal succeeded
    _block() {
        engine::python::LockPython lock;

        slot.global = {};
    }
    slot.built = false;

    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Bind a binding to its control's IGlobal, building it on the first
///		touch (plan 4.1 rules 1-2)
//-------------------------------------------------------------------------
ErrorOr<IPythonGlobalBase::SlotPtr> IPythonGlobalBase::acquireSlot(
    const py::object &caller) noexcept {
    if (m_boundError) return m_boundError;

    if (!m_pyGlobalClass)
        return APERR(Ec::InvalidCommand, "No IGlobal is built in config mode",
                     pipeType.id);

    // Step 1: which control this binding runs under, and the configuration
    // its open carried for this node (the open only; a write/close/tool
    // names the control alone and finds the slot the open built)
    Text controlId;
    std::optional<json::Value> config;
    const auto readCaller = localfcn()->Error {
        if (!caller || !py::isinstance<py::dict>(caller)) return {};
        const py::dict dict = py::reinterpret_borrow<py::dict>(caller);

        if (dict.contains("controlId") && !dict["controlId"].is_none())
            controlId = py::cast<std::string>(dict["controlId"]);

        if (m_stackIndex && dict.contains("config") &&
            py::isinstance<py::list>(dict["config"])) {
            const py::list list = dict["config"];
            if (*m_stackIndex < list.size() &&
                py::isinstance<py::dict>(list[*m_stackIndex]))
                config = engine::python::pyjson::dictToJson(
                    list[*m_stackIndex].cast<py::dict>());
        }
        return {};
    };
    if (auto ccode = callPython(readCaller)) return ccode;

    // Step 2: find or create the slot and claim it. The wait releases the
    // GIL, so the binding that is building it can run Python meanwhile; a
    // slot the sweep retired while we waited sends us back for a new one
    for (;;) {
        SlotPtr slot;
        _block() {
            std::lock_guard<std::mutex> guard(m_slotsLock);
            auto &entry = m_slots[controlId];
            if (!entry) entry = std::make_shared<GlobalSlot>();
            slot = entry;
        }

        // The guard unlocks through the slot itself, never through the
        // handle: `return slot` moves the handle out before the guard runs
        GlobalSlot &held = *slot;
        _block() {
            engine::python::UnlockPython unlock;
            held.lock.lock();
        }
        util::Guard unlockSlot{[] {}, [&held] { held.lock.unlock(); }};

        if (slot->retired) continue;

        // Step 3: the first touch builds it
        if (!slot->built) {
            // A control's configuration comes with its open; the default
            // slot (no caller) and a node the open's list does not address
            // (no stack index) run on the node's own connConfig
            json::Value connConfig;
            if (config)
                connConfig = _mv(*config);
            else if (controlId.empty() || !m_stackIndex)
                connConfig = pipeType.connConfig;

            Error ccode;
            if (!config && !controlId.empty() && m_stackIndex)
                ccode = APERR(Ec::InvalidCommand, "No configuration for control",
                              controlId, "on node", pipeType.id,
                              "- the control's open did not reach this engine");
            else
                ccode = buildSlot(*slot, controlId, _mv(connConfig));

            // A build that failed is not a slot: the next open tries again
            if (ccode) {
                slot->retired = true;
                std::lock_guard<std::mutex> guard(m_slotsLock);
                if (auto it = m_slots.find(controlId);
                    it != m_slots.end() && it->second == slot)
                    m_slots.erase(it);
                return ccode;
            }
        }

        // Step 4: the binding holds the slot from here to releaseSlot
        ++slot->bindings;
        slot->lastTouch = Clock::now();
        return slot;
    }
}

//-------------------------------------------------------------------------
/// @details
///		Release a binding's hold and touch the slot
//-------------------------------------------------------------------------
void IPythonGlobalBase::releaseSlot(SlotPtr &slot) noexcept {
    if (!slot) return;

    slot->lastTouch = Clock::now();
    --slot->bindings;
    slot.reset();
}

//-------------------------------------------------------------------------
/// @details
///		The controls holding an IGlobal on this node
//-------------------------------------------------------------------------
std::vector<Text> IPythonGlobalBase::controlIds() noexcept {
    std::vector<Text> ids;

    std::lock_guard<std::mutex> guard(m_slotsLock);
    for (auto &[controlId, slot] : m_slots)
        if (slot->built.load()) ids.push_back(controlId);
    return ids;
}

//-------------------------------------------------------------------------
/// @details
///		End and erase every slot of this node idle since `before` with no
///		open binding. The candidates are picked under the map lock (the
///		atomics only), then each is re-checked under its own lock: a
///		binding that claimed it meanwhile keeps it. The slot stays in the
///		map, retired, until its endGlobal has RUN: a binding arriving
///		meanwhile waits on the slot lock (GIL released), wakes on the
///		retired slot and builds a fresh one only after the old global
///		released what it held, so two IGlobals of one control never
///		overlap on an exclusive resource
//-------------------------------------------------------------------------
void IPythonGlobalBase::sweepIdle(Clock::time_point before) noexcept {
    // Step 1: the idle candidates
    std::vector<std::pair<std::string, SlotPtr>> candidates;
    _block() {
        std::lock_guard<std::mutex> guard(m_slotsLock);
        for (auto &[controlId, slot] : m_slots)
            if (slot->built.load() && slot->bindings.load() == 0 &&
                slot->lastTouch.load() < before)
                candidates.emplace_back(controlId, slot);
    }

    // Step 2: end each one that is still idle
    for (auto &[controlId, slot] : candidates) {
        std::lock_guard<std::mutex> guard(slot->lock);

        if (slot->retired || !slot->built.load() ||
            slot->bindings.load() != 0 || slot->lastTouch.load() >= before)
            continue;

        // Retired first: a waiter that wakes on it goes back to the map
        slot->retired = true;

        // An endGlobal that fails is the ops stream's to know (>ERR); the
        // slot is gone either way
        if (auto ccode = endSlot(*slot); ccode && ::engine::config::monitor())
            ::engine::config::monitor()->error(_mv(ccode));

        // Out of the map only now, with the old global ended
        _block() {
            std::lock_guard<std::mutex> mapGuard(m_slotsLock);
            if (auto it = m_slots.find(controlId);
                it != m_slots.end() && it->second == slot)
                m_slots.erase(it);
        }

        LOG(Python, "Ended the idle IGlobal of control", controlId, "on",
            pipeType.id);
    }
}

//-------------------------------------------------------------------------
/// @details
///		The engine-wide sweep over every live node global. The registry
///		lock covers the snapshot only: each global is pinned (m_sweepHold)
///		while its sweepIdle runs, so its destructor waits for the sweep
///		instead of the sweep holding a lock across a node's endGlobal -
///		which may itself construct or destroy a global (validatePipeline
///		from Python) and would block on the same, non-recursive, lock
//-------------------------------------------------------------------------
void IPythonGlobalBase::sweepIdleGlobals(std::chrono::seconds idle) noexcept {
    const auto before = Clock::now() - idle;

    // Step 1: pin every live global
    std::vector<IPythonGlobalBase *> globals;
    _block() {
        std::lock_guard<std::mutex> guard(s_registryLock);
        globals.reserve(s_registry.size());
        for (auto *global : s_registry) {
            ++global->m_sweepHold;
            globals.push_back(global);
        }
    }

    // Step 2: sweep each outside the registry lock, then let it go
    for (auto *global : globals) {
        global->sweepIdle(before);

        _block() {
            std::lock_guard<std::mutex> guard(s_registryLock);
            --global->m_sweepHold;
        }
        s_registryIdle.notify_all();
    }
}

//-------------------------------------------------------------------------
/// @details
///		The sweep thread: every CONST_IGLOBAL_SWEEP_SECONDS, end the
///		controls idle longer than CONST_IGLOBAL_IDLE_SECONDS
//-------------------------------------------------------------------------
void IPythonGlobalBase::sweepProcess() noexcept {
    while (!async::cancelled()) {
        // Sleep the period in short steps so a stop is prompt
        for (int tick = 0; tick < CONST_IGLOBAL_SWEEP_SECONDS * 10; ++tick) {
            if (async::cancelled()) return;
            async::sleep(100ms);
        }

        sweepIdleGlobals(std::chrono::seconds(CONST_IGLOBAL_IDLE_SECONDS));
    }
}

}  // namespace engine::store::pythonBase
