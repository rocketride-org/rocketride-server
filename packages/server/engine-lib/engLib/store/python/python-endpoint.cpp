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

#include <engLib/eng.h>

namespace engine::store::pythonBase {
//-------------------------------------------------------------------------
/// @details
///		Constructor - creates underlying python objects and binds them
///		to the handles.
//-------------------------------------------------------------------------
IPythonEndpointBase::IPythonEndpointBase(const FactoryArgs &args) noexcept
    : Parent(args) {
    // Get our service definition
    auto service = IServices::getServiceDefinition(args.filter.logicalType);
    if (!service) {
        m_boundError = service.ccode();
        return;
    }
    const auto &serviceDef = **service;

    // Determine the module to load from serviceDef.nodePath, if specified,
    // or from pipeType.logicalType - otherwise
    auto servicePath = serviceDef.nodePath
                           ? _cast<TextView>(serviceDef.nodePath)
                           : _cast<TextView>(pipeType.logicalType);

    // Load python module
    engine::python::LockPython lock;
    auto pyModule = engine::python::loadModule(servicePath, true);
    if (!pyModule) {
        m_boundError = pyModule.ccode();
        return;
    }

    // Save the module
    m_pyModule = *pyModule;

    // Define this so we can set a breakpoint if we need to
    auto python = localfcn()->Error {
        // This is not optional
        if (!py::hasattr(m_pyModule, "IEndpoint"))
            return APERR(Ec::InvalidModule, "Class IEndpoint is missing");

        // Create the python endpoint instance
        m_pyEndpoint = m_pyModule.attr("IEndpoint")();

        // Initialize the python endpoint with this host service
        m_pyEndpoint.attr("endpoint") =
            py::cast(static_cast<IServiceEndpoint *>(this));
        return {};
    };

    // Instantiate the IEndpoint class in python
    m_boundError = callPython(python);
}

//-------------------------------------------------------------------------
/// @details
///		Destructor - ends the endpoint. We need to do this here since, if
///		we just let the IServiceEndpoint do it, it will only clean up
///		itself, not our allocations. We will also make sure our python
///		ptrs are clean up properly
//-------------------------------------------------------------------------
IPythonEndpointBase::~IPythonEndpointBase() noexcept {
    // Make sure the endpoint is cleaned up
    endEndpoint();

    // Clean up python side
    _block() {
        engine::python::LockPython lock;

        m_pyEndpoint = {};
        m_pyModule = {};
    }
}

//-------------------------------------------------------------------------
/// @details
///		Begins the endpoint operation
//-------------------------------------------------------------------------
Error IPythonEndpointBase::beginEndpoint(OPEN_MODE openMode_) noexcept {
    if (m_boundError) return m_boundError;

    // Do not call beginEndpoint/endEndpoint of the python node for commitScan
    auto taskType = config.jobConfig["type"].asString();

    // @@HACK - Another barnacle - this should be handled by the python
    // endpoint driver itself.
    if (taskType != task::commitScan::Task::Type) {
        // Hack:
        //  Config.openMode is needed in Python's IEndpont::beginEndpoint, but
        //  is not passed there. It is set in Parent::beginEndpoint. Reset is
        //  required because Parent::beginEndpoint checks it.
        util::Guard pipes{[&] { config.openMode = openMode_; },
                          [&] { config.openMode = OPEN_MODE::NONE; }};

        // Define this so we can set a breakpoint if we need to
        auto python = localfcn()->Error {
            if (py::hasattr(m_pyEndpoint, "beginEndpoint"))
                m_pyEndpoint.attr("beginEndpoint")();
            return {};
        };

        // Start the endpoint
        if (auto ccode = callPython(python)) return ccode;
    }

    // Call the parent first so open mode is set
    if (auto ccode = Parent::beginEndpoint(openMode_)) return ccode;

    // And done
    return {};
};

//-------------------------------------------------------------------------
/// @details
///		Sets up the endpoint
///	@param[in]	openMode
///		The open mode. Will be either READ or WRITE
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IPythonEndpointBase::signal(const Text &signal,
                                  json::Value &param) noexcept {
    // End the python endpoint
    const auto python = localfcn()->Error {
        // If it doesn't have the signal function, done
        if (!py::hasattr(m_pyEndpoint, "signal")) return {};

        // Call the signal function
        m_pyEndpoint.attr("signal")(signal, param);
        return {};
    };

    // Call it
    if (auto ccode = callPython(python)) return ccode;

    // And call the parent
    return Parent::signal(signal, param);
}

//-------------------------------------------------------------------------
/// @details
///		End the endpoint operation
/// @param[in] path
///		The path to wrap
/// @param[out] url
//		Receives the url encoded path
//-------------------------------------------------------------------------
Error IPythonEndpointBase::endEndpoint() noexcept {
    if (m_boundError) return m_boundError;

    // End the python endpoint
    const auto python = localfcn()->Error {
        Error ccode;

        // If we setup the endpoint
        if (m_pyEndpoint) {
            // Do not call beginEndpoint/endEndpoint of the python node for
            // commitScan
            auto taskType = config.jobConfig["type"].asString();

            // @@HACK Use taskType == task::commitScan::Task::Type - do not use
            // Txticmp - that is the old C way. Also, this should always be
            // called regardless of the task type
            if (Txticmp(taskType, task::commitScan::Task::Type) != 0) {
                // This may actually fail, so grab the return code
                ccode = _callChk([&] {
                    if (py::hasattr(m_pyEndpoint, "endEndpoint"))
                        m_pyEndpoint.attr("endEndpoint")();
                    return Error{};
                });
            }

            // Release the endpoint
            m_pyEndpoint = {};
        }

        // Release the module if we have it
        m_pyModule = {};
        return ccode;
    };

    // Call it
    if (auto ccode = callPython(python)) return ccode;

    // And call the parent
    return Parent::endEndpoint();
};

}  // namespace engine::store::pythonBase
