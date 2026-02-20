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
///		End the endpoint operation
/// @param[in] currentThreadCount
///		Current thread count
/// @returns uint32_t
///		Returns the thread count to be used for processing.
//-------------------------------------------------------------------------
uint32_t IPythonInstanceBase::getThreadCount(
    uint32_t currentThreadCount) const noexcept {
    uint32_t value = currentThreadCount;

    // Get permissions in bulk
    const auto python = localfcn()->Error {
        // If we don't have a getThreadCount method
        if (!(m_pyMethods & PythonMethod::GetThreadCount)) {
            // should it be recorded somewhere??
            LOGT("No getThreadCount, returning", currentThreadCount);
            return {};
        }

        // Bind the object
        auto pythonObject = py::cast(currentThreadCount);

        // Call it
        auto res = m_pyInstance.attr("getThreadCount")(pythonObject);
        if (res.is_none()) return {};

        value = res.cast<uint32_t>();
        return {};
    };

    // Call it
    callPython(python);

    return value;
};

//-------------------------------------------------------------------------
/// @details
///		Checks if the object has changed. It does this by examining the
///		dates/times and anything else to determine if the object has
///		changed. If it has, this method should call the entry.markChanged<>
///		function. Also, if it has changed, be sure to update all the
///		changed fields in the entry
///	@param[inout] object
///		The entry to check/update
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IPythonInstanceBase::checkChanged(Entry &object) noexcept {
    LOGPIPE();

    // Check if the entry has changed
    const auto python = localfcn()->Error {
        // If we don't have a check changed
        if (!(m_pyMethods & PythonMethod::CheckChanged)) {
            object.markChanged(Lvl::ServicePython,
                               "No checkChanged, defaulting to changed");
            return {};
        }

        // Bind the object
        auto pythonObject = py::cast(&object);

        // Call it
        m_pyInstance.attr("checkChanged")(pythonObject);
        return {};
    };

    return callPython(python);
}

//-----------------------------------------------------------------
/// @details
///		Removes the entry
///	@param[in] entry
///		The entry to remove
///	@returns
///		Error
//-----------------------------------------------------------------
Error IPythonInstanceBase::removeObject(Entry &object) noexcept {
    LOGPIPE();

    // Remove the object
    const auto python = localfcn()->Error {
        // Check it first
        if (!py::hasattr(m_pyInstance, "removeObject"))
            return APERR(Ec::InvalidCommand,
                         "The node does not support the removeObject");

        // Bind the object
        auto pythonObject = py::cast(&object);

        // Call it
        m_pyInstance.attr("removeObject")(pythonObject);
        return {};
    };

    return callPython(python);
}

//---------------------------------------------------------------------
/// @details
///		Determines existence of the entry
///	@param[in]	object
///		The entry that should be stat-ed
///	@returns
///     true - if the file does not exist, false - if the file exists,
///     error code - if there are some errors
//---------------------------------------------------------------------
ErrorOr<bool> IPythonInstanceBase::stat(Entry &object) noexcept {
    Error ccode;

    LOGPIPE();

    bool statRes = false;

    // Stat the object
    const auto python = localfcn()->Error {
        // Check it first
        if (!py::hasattr(m_pyInstance, "stat"))
            return APERR(Ec::InvalidCommand,
                         "The node does not support the stat interface");

        // Bind the object
        auto pythonObject = py::cast(&object);

        // Call it
        auto statResObj = m_pyInstance.attr("stat")(pythonObject);
        statRes = py::str(statResObj).is(py::str(Py_True));
        return {};
    };

    if (ccode = callPython(python)) return ccode;

    return statRes;
}

//-----------------------------------------------------------------------------
/// @details
///		This function will determine which format the source is in according
///		to the config and either forward it on if it is not rocketride format,
///		or read the segments parse them and send them to the the target
///	@param[in]	target
///		the output channel
///	@param[in]	object
///		object information
///	@returns
///		Error
//-----------------------------------------------------------------------------
Error IPythonInstanceBase::renderObject(ServicePipe &target,
                                        Entry &object) noexcept {
    Error ccode;

    LOGPIPE();

    // The object is required for python callbacks. Perhaps, it makes sense
    // to store current object on the top level for other streams and tasks.
    if (currentEntry != nullptr)
        return APERRT(Ec::InvalidCommand, "Object is already open on pipe",
                      pipeId);

    util::Guard currentEntryGuard{localfcn(){currentEntry = &object;
}
, localfcn() { currentEntry = nullptr; }
};  // namespace engine::store::pythonBase

// Check if the entry has changed
const auto python = localfcn()->Error {
    // Check it
    if (!py::hasattr(m_pyInstance, "renderObject"))
        return APERR(Ec::InvalidCommand,
                     "The node does not support the renderObject interface");

    // Bind the object
    auto pythonObject = py::cast(&object);

    m_pyInstance.attr("renderObject")(pythonObject);
    return {};
};

// Save the target so our sendX() functions can get to it
m_pTarget = &target;

// Setup for writting metadata
m_metadataWritten = false;
m_metadata = {};

// Save the basic metadata
m_metadata["flags"] = 0;
m_metadata["url"] = (TextView)object.url();

// Call it
ccode = callPython(python);

// If we are supposed to skip the parent call or not
if (checkCallParent(ccode)) ccode = Parent::renderObject(target, object);

// Clear the target and return
m_pTarget = nullptr;
return ccode;
}
}
