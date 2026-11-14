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
///		Constructor - creates underlying python objects and binds them
///		to the handles.
//-------------------------------------------------------------------------
IPythonInstanceBase::IPythonInstanceBase(const FactoryArgs &args) noexcept
    : Parent(args),
      m_global((static_cast<IPythonGlobalBase &>(*args.global))),
      m_endpoint((static_cast<IPythonEndpointBase &>(*args.endpoint))) {
    // Setup the instance filter
    const auto python = localfcn()->Error {
        // Load the rocketlib module
        py::object pyRocketRide = python::loadModule("rocketlib");

        // Get the base class - this will throw if not there
        py::object pyBaseClass = pyRocketRide.attr("IInstanceBase");

        // Import the node's <path>.IInstance submodule and get the class -
        // both will throw if not there. The CLASS is kept: an instance is
        // constructed per binding, on the first touch (beginBinding)
        const Text moduleName = _ts(m_global.m_modulePath, ".IInstance");
        py::object pyInstanceModule = python::loadModule(moduleName);
        py::object pyInstanceClass = pyInstanceModule.attr("IInstance");
        m_pyInstanceClass = pyInstanceClass;

        // Determine if a function is supported or not - probed on the
        // class once, never per instance
        auto bindMethod =
            localfcn(PythonMethod pyMethod, const char *pyMethodName) {
            // If this doesn't have it at all, it is not bound - happens if the
            // function is not defined in the IInstance class and it is not
            // derived from IInstanceBase
            if (!py::hasattr(pyInstanceClass, pyMethodName)) return;

            // If it isn't in the base class then someone forgot to update
            // the defintion in rocketride python interface
            if (!py::hasattr(pyBaseClass, pyMethodName)) {
                LOG(DebugOut, "Method", pyMethodName,
                    "was not found in IInstanceBase. Update rocketlib "
                    "interface module.");
                m_pyMethods |= pyMethod;
                return;
            }

            // Get the method from the base class
            const auto pyBaseClassMethod = pyBaseClass.attr(pyMethodName);

            // Get the method from the instance class - not our instatiation
            // of the instance class
            const auto pyInstanceClassMethod =
                pyInstanceClass.attr(pyMethodName);

            // If it is getting the method from the base class, not bound
            if (pyInstanceClassMethod.is(pyBaseClassMethod)) return;

            // It is bound, so enable it
            m_pyMethods |= pyMethod;
        };

        bindMethod(PythonMethod::BeginInstance, "beginInstance");
        bindMethod(PythonMethod::EndInstance, "endInstance");
        bindMethod(PythonMethod::CheckChanged, "checkChanged");
        bindMethod(PythonMethod::Control, "control");
        bindMethod(PythonMethod::Open, "open");
        bindMethod(PythonMethod::Closing, "closing");
        bindMethod(PythonMethod::Close, "close");

        bindMethod(PythonMethod::WriteTag, "writeTag");
        bindMethod(PythonMethod::WriteText, "writeText");
        bindMethod(PythonMethod::WriteTable, "writeTable");
        bindMethod(PythonMethod::WriteWords, "writeWords");
        bindMethod(PythonMethod::WriteJson, "writeJson");
        bindMethod(PythonMethod::WriteAudio, "writeAudio");
        bindMethod(PythonMethod::WriteVideo, "writeVideo");
        bindMethod(PythonMethod::WriteImage, "writeImage");
        bindMethod(PythonMethod::WriteQuestions, "writeQuestions");
        bindMethod(PythonMethod::WriteAnswers, "writeAnswers");
        bindMethod(PythonMethod::WriteClassifications, "writeClassifications");
        bindMethod(PythonMethod::WriteClassificationContext,
                   "writeClassificationContext");
        bindMethod(PythonMethod::WriteDocuments, "writeDocuments");

        bindMethod(PythonMethod::GetPermissions, "getPermissions");
        bindMethod(PythonMethod::GetPermissionsBulk, "getPermissionsBulk");
        bindMethod(PythonMethod::OutputPermissions, "outputPermissions");

        bindMethod(PythonMethod::GetThreadCount, "getThreadCount");

        return {};
    };

    m_boundError = callPython(python);
}

//-------------------------------------------------------------------------
/// @details
///		Destructor - makes sure we safely remove ptrs under the GIL
//-------------------------------------------------------------------------
IPythonInstanceBase::~IPythonInstanceBase() {
    _block() {
        engine::python::LockPython lock;

        m_pyInstance = {};
        m_pyInstanceClass = {};
    }
}

//-------------------------------------------------------------------------
/// @details
///		The node's IInstance for the current binding. The first call under
///		a binding constructs it (bindToGeneration -> beginBinding); later
///		calls return the same object until putPipe() ends the binding.
///		Called with the GIL held, from inside a callPython lambda or a
///		pybind getter: a bind failure is thrown as the Error it is
//-------------------------------------------------------------------------
py::object &IPythonInstanceBase::boundInstance() {
    if (m_boundError) throw m_boundError;

    if (auto ccode = bindToGeneration()) throw ccode;

    if (!m_pyInstance)
        throw APERR(Ec::InvalidCommand, "The node instance is not bound",
                    pipeType.id);

    return m_pyInstance;
}

//-------------------------------------------------------------------------
/// @details
///		Per-binding constructor (plan 4.1 rule 2). Builds the node's
///		IInstance and sets up the following on it
///
///			IEndpoint		contains an object of the users IEndpoint class
///			IGlobal			contains an object of the users IGlobal class
///			instance		this IPythonInstanceBase class which allows
///							access to instance functions
///			_caller			the binding's caller context from the pipe,
///							when the opener set one
///
///			endpoint		<deprecated> - use IEndpoint.endpoint
///
///		then calls beginInstance() when the node defines it. The caller
///		context is in place before the node's first line of code runs
//-------------------------------------------------------------------------
Error IPythonInstanceBase::beginBinding() noexcept {
    LOGPIPE();

    if (m_boundError) return m_boundError;

    const auto python = localfcn()->Error {
        // Create a new instance
        m_pyInstance = m_pyInstanceClass();

        // Save the python part of the endpoint
        m_pyInstance.attr("IEndpoint") = m_global.m_pyEndpoint;

        // We may not have an IGlobal
        if (m_global.m_pyGlobal)
            m_pyInstance.attr("IGlobal") = m_global.m_pyGlobal;

        // Save the ptr to our functions
        m_pyInstance.attr("instance") = this;

        // <deprecated>
        //		This is for compatability but it is ambiguous
        m_pyInstance.attr("endpoint") = m_global.m_pyEndpoint;
        // <deprecated>

        // The binding's caller context, when the opener stamped one
        if (pipe && pipe->caller) m_pyInstance.attr("_caller") = pipe->caller;

        // If it has a begin instance, call it
        if (m_pyMethods & PythonMethod::BeginInstance)
            m_pyInstance.attr("beginInstance")();
        return {};
    };

    auto ccode = callPython(python);

    // A constructor that failed half way leaves no instance: the binding
    // stays recorded (putPipe ends it), the node is simply not there
    if (ccode) {
        engine::python::LockPython lock;

        m_pyInstance = {};
    }

    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Per-binding destructor (plan 4.1 rule 2): endInstance() when the
///		node defines it, then the instance is dropped. The handle is
///		taken off this filter BEFORE endInstance runs, so a node that
///		fails on its way out still leaves nothing behind
//-------------------------------------------------------------------------
Error IPythonInstanceBase::endBinding() noexcept {
    LOGPIPE();

    const auto python = localfcn()->Error {
        if (!m_pyInstance) return {};

        auto instance = _mv(m_pyInstance);
        m_pyInstance = {};

        if (m_pyMethods & PythonMethod::EndInstance)
            instance.attr("endInstance")();
        return {};
    };

    return callPython(python);
}

//-------------------------------------------------------------------------
/// @details
///		Begins the filter for its slot. Per-binding state is beginBinding's
//-------------------------------------------------------------------------
Error IPythonInstanceBase::beginFilterInstance() noexcept {
    LOGPIPE();

    if (m_boundError) return m_boundError;

    // The node's instance is NOT built here: it is constructed per
    // binding on the first touch (beginBinding). The filter object itself
    // stays with the slot
    return Parent::beginFilterInstance();
}

//-------------------------------------------------------------------------
/// @details
///		Ends the filter for its slot
//-------------------------------------------------------------------------
Error IPythonInstanceBase::endFilterInstance() noexcept {
    LOGPIPE();

    if (m_boundError) return m_boundError;

    // A binding still in progress (the endpoint closing under an open
    // pipe) is ended with the filter
    auto ccode = releaseBinding();

    return checkCallParent(ccode) ? Parent::endFilterInstance() : ccode;
}
}  // namespace engine::store::pythonBase
