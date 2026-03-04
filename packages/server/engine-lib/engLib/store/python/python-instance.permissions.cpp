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
///		Gets permissions of the objects
///	@param[inout] object
///		The entry to get permissions for
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IPythonInstanceBase::getPermissions(Entry& entry) noexcept {
    LOGPIPE();

    // Get permissions
    const auto python = localfcn()->Error {
        // If we don't have a getPermissions method
        if (!(m_pyMethods & PythonMethod::GetPermissions)) {
            // should it be recorded somewhere??
            LOGT("No getPermission, defaulting to no permissions for the entry",
                 entry);
            return {};
        }

        // Bind the object
        auto pythonObject = py::cast(&entry);

        // Call it
        m_pyInstance.attr("getPermissions")(pythonObject);
        return {};
    };

    // Call it
    return callPython(python);
}

//-------------------------------------------------------------------------
/// @details
///		Gets permissions of the objects
///	@param[inout] object
///		The vector of entries to get permissions for
///	@returns
///		Error
//-------------------------------------------------------------------------
ErrorOr<size_t> IPythonInstanceBase::getPermissions(
    std::vector<Entry>& entries) noexcept {
    // if wrong value is returned -> set batch size to 1
    size_t value = 1;

    // Get permissions in bulk
    const auto python = localfcn()->Error {
        // If we don't have a getPermissions method
        if (!(m_pyMethods & PythonMethod::GetPermissionsBulk)) {
            // should it be recorded somewhere??
            LOGT("No getPermissionBulk, will process one entry at a time",
                 entries);
            return APERR(Ec::NotSupported, "getPermissionsBulk not supported");
        }

        // Bind the object
        auto pythonObject = py::cast(&entries);

        // Call it
        auto res = m_pyInstance.attr("getPermissionsBulk")(pythonObject);
        if (res == py::none()) return {};
        value = res.cast<size_t>();
        return {};
    };

    // Call it
    if (auto ccode = callPython(python)) return ccode;

    return value;
}

//---------------------------------------------------------------------
/// @details
///		Outputs the current list of permissions
///	@returns
///     std::list - list of permission ids
///     error code - if there are some errors
//---------------------------------------------------------------------
ErrorOr<std::list<Text>> IPythonInstanceBase::outputPermissions() noexcept {
    return m_endpoint.outputPermissions();
}
}  // namespace engine::store::pythonBase
