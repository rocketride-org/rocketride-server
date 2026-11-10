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
///		Constructor - creates underlying python objects and binds them
///		to the handles. The node package contract is file-per-class:
///		<path>.IGlobal is imported when the pipe runs, and in CONFIG /
///		PIPELINE_CONFIG mode only <path>.IValidator (falling back to
///		rocketlib.IValidatorBase) - IGlobal.py is never imported there.
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

        if (m_pyModule) {
            // The file is present, so the class is not optional
            if (!py::hasattr(m_pyModule, className))
                return APERR(Ec::InvalidModule, "Class", className,
                             "is missing from", _ts(m_modulePath, ".",
                                                    className));

            // Create an instance of the IGlobal / IValidator class
            m_pyGlobal = m_pyModule.attr(className)();
        } else if (configMode) {
            // No IValidator.py: the framework default validates the
            // configuration against the schema
            Text utilName = "rocketlib";
            auto pyUtil = engine::python::loadModule(utilName);
            if (!pyUtil) return pyUtil.ccode();

            if (!py::hasattr(*pyUtil, "IValidatorBase"))
                return APERR(Ec::InvalidModule,
                             "The IValidatorBase template is missing");

            m_pyGlobal = pyUtil->attr("IValidatorBase")();
        }

        // If we have a global data instance, bind it to this host service
        if (m_pyGlobal) {
            // Initialize the python endpoint with this host service
            m_pyGlobal.attr("IEndpoint") = m_pyEndpoint;

            // Save the info into pythons IGlobal
            m_pyGlobal.attr("glb") = this;
        }

        // And done
        return {};
    };

    m_boundError = callPython(python);
}

//-------------------------------------------------------------------------
/// @details
///		Destructor - ends the endpoint. We need to do this here since, if
///		we just let the IServiceEndpoint do it, it will only clean up
///		itself, not our allocations. We will also make sure our python
///		ptrs are clean up properly
//-------------------------------------------------------------------------
IPythonGlobalBase::~IPythonGlobalBase() noexcept {
    // Clean up python side
    _block(){engine::python::LockPython lock;

m_pyEndpoint = {};
m_pyModule = {};
m_pyGlobal = {};
}  // namespace engine::store::pythonBase
}
;

//-------------------------------------------------------------------------
/// @details
///		Within the python model, global data is not necessary as all
///		values can be stored within the IEndpoint itself
//-------------------------------------------------------------------------
Error IPythonGlobalBase::beginFilterGlobal() noexcept {
    LOGPIPE();

    if (m_boundError) return m_boundError;

    // Begin the instance filter
    auto python = localfcn()->Error {
        // If we have an end function
        if (m_pyGlobal && py::hasattr(m_pyGlobal, "beginGlobal"))
            m_pyGlobal.attr("beginGlobal")();
        return {};
    };

    auto ccode = callPython(python);

    return checkCallParent(ccode) ? Parent::beginFilterGlobal() : ccode;
};

//-------------------------------------------------------------------------
/// @details
///		Within the python model, global data is not necessary as all
///		values can be stored within the IEndpoint itself
//-------------------------------------------------------------------------
Error IPythonGlobalBase::endFilterGlobal() noexcept {
    LOGPIPE();

    if (m_boundError) return m_boundError;

    // End the instance filter
    const auto python = localfcn()->Error {
        // If we have an end function
        if (m_pyGlobal && py::hasattr(m_pyGlobal, "endGlobal"))
            m_pyGlobal.attr("endGlobal")();

        // Release the endpoint, the global and the module
        m_pyEndpoint = {};
        m_pyGlobal = {};
        m_pyModule = {};
        return {};
    };

    auto ccode = callPython(python);

    return checkCallParent(ccode) ? Parent::endFilterGlobal() : ccode;
};

Error IPythonGlobalBase::validateConfig() noexcept {
    LOGPIPE();

    if (m_boundError) return m_boundError;

    const auto python = localfcn()->Error {
        // If we have an IGlobal
        if (m_pyGlobal) {
            if (py::hasattr(m_pyGlobal, "validateConfig"))
                m_pyGlobal.attr("validateConfig")();
        }
        return {};
    };

    auto ccode = callPython(python);

    return checkCallParent(ccode) ? Parent::validateConfig() : ccode;
}

}  // namespace engine::store::pythonBase
