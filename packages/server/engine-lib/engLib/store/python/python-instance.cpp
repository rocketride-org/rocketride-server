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

        // Get the instance class - this will throw if not there
        py::object pyInstanceClass = m_global.m_pyModule.attr("IInstance");

        // Create a new instance
        m_pyInstance = pyInstanceClass();

        // Save the phython part of the endpoint
        m_pyInstance.attr("IEndpoint") = m_global.m_pyEndpoint;

        // We may not have an IGlobal
        if (m_global.m_pyGlobal)
            m_pyInstance.attr("IGlobal") = m_global.m_pyGlobal;

        // Give the python object a handle to our functions. It is bound to
        // this filter in beginFilterInstance, once the weak self link exists
        m_handle = std::make_shared<NodeHandle>();
        m_pyInstance.attr("instance") = m_handle;

        // <deprecated>
        //		This is for compatability but it is ambiguous
        m_pyInstance.attr("endpoint") = m_global.m_pyEndpoint;
        // <deprecated>

        // Determine if a function is supported or not
        auto bindMethod =
            localfcn(PythonMethod pyMethod, const char *pyMethodName) {
            // If this doesn't have it at all, it is not bound - happens if the
            // function is not defined in the IInstance class and it is not
            // derived from IInstanceBase
            if (!py::hasattr(m_pyInstance, pyMethodName)) return;

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
    }
}

//-------------------------------------------------------------------------
/// @details
///		The node's IInstance for an engine entry into the node
//-------------------------------------------------------------------------
py::object IPythonInstanceBase::boundInstance() {
    if (m_pyEnded)
        throw APERR(Ec::PipelineEnded, PipelineEndedMessage);

    if (!m_pyInstance)
        throw APERR(Ec::InvalidCommand, "The node instance is not bound",
                    pipeType.id);

    return m_pyInstance;
}

//-------------------------------------------------------------------------
/// @details
///		Allocates the instance data. We set up the following on the users
///		IInstance object
///
///			IEndpoint		contains an object of the users IEndpoint class
///			IGlobal			contains an object of the users IGlobal class
///			instance		a handle to this filter which allows
///							access to instance functions
///
///			endpoint		<deprecated> - use IEndpoint.endpoint
///
//-------------------------------------------------------------------------
Error IPythonInstanceBase::beginFilterInstance() noexcept {
    LOGPIPE();

    if (m_boundError) return m_boundError;

    // Point the python handle at this filter before python can use it
    if (m_handle)
        m_handle->bind(this->instance);

    // Calls the begin instance on the python filter
    const auto python = localfcn()->Error {
        // If it has a begin instance, call it
        if (m_pyMethods & PythonMethod::BeginInstance)
            m_pyInstance.attr("beginInstance")();
        return {};
    };

    auto ccode = callPython(python);

    return checkCallParent(ccode) ? Parent::beginFilterInstance() : ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Calls the node's endInstance if it has one, then marks the node
///		ended and releases its object, also when endInstance raises.
///		The parent's endFilterInstance() runs only when endInstance did
///		not raise (a preventDefault counts as raising). A node that
///		failed to bind returns its bind error and runs neither
///	@returns
///		The bind error, else endInstance's error (none for a
///		preventDefault), else the parent's
//-------------------------------------------------------------------------
Error IPythonInstanceBase::endFilterInstance() noexcept {
    LOGPIPE();

    if (m_boundError) return m_boundError;

    // End the instance filter
    const auto python = localfcn()->Error {
        // If we have an instance
        if (m_pyInstance) {
            // Ends the node on the way out, also when endInstance raises.
            // The flag goes first: releasing the object can run Python
            // code, which can hand the GIL to another thread
            util::Guard ended{[&] {
                m_pyEnded = true;
                m_pyInstance = {};
            }};

            // If it has an end instance method, call it
            if (m_pyMethods & PythonMethod::EndInstance)
                m_pyInstance.attr("endInstance")();
        }
        return {};
    };

    auto ccode = callPython(python);

    return checkCallParent(ccode) ? Parent::endFilterInstance() : ccode;
}
}  // namespace engine::store::pythonBase
