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
///		Notify the filter to control an object
//-------------------------------------------------------------------------
Error IPythonInstanceBase::control(py::object &control) noexcept {
    LOGPIPE();

    auto python = localfcn() {
        // Call it
        m_pyInstance.attr("control")(control);
    };

    // On control, we are not going to check the flag because, most likely
    // it is going to the base classes dispatcher
    return callPython(python);
}

//-------------------------------------------------------------------------
/// @details
///		Notify the filter to open the current document
//-------------------------------------------------------------------------
Error IPythonInstanceBase::open(Entry &object) noexcept {
    LOGPIPE();

    // Call the parent
    if (auto ccode = Parent::open(object)) return ccode;

    // Create the target url
    if (auto ccode = endpoint->mapPath(object.url(), m_targetObjectUrl))
        return ccode;

    // Create the target path
    if (auto ccode = Url::toPath(m_targetObjectUrl, m_targetObjectPath))
        return ccode;

    auto python = localfcn() {
        // Bind the object
        auto pyObject = py::cast(&object);

        // Call it
        m_pyInstance.attr("open")(pyObject);
    };

    // Check if the method is supported by the python endpoint
    if (m_pyMethods & PythonMethod::Open) return callPython(python);

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Process and write a tag
/// @param[in]	pTag
///		The tag from input pipe
//-------------------------------------------------------------------------
Error IPythonInstanceBase::writeTag(const TAG *pTag) noexcept {
    Error ccode;

    LOGPIPE();

    // If the method is not supported by the python endpoint, push it down
    if (!(m_pyMethods & PythonMethod::WriteTag)) return Parent::writeTag(pTag);

    auto python = localfcn()->Error {
        py::object pyTag = py::cast(pTag, py::return_value_policy::reference);

        // Call it
        auto res = m_pyInstance.attr("writeTag")(pyTag);
        if (res == py::none()) return {};
        int value = py::int_(res);
        if (value)
            currentEntry->completionCode(APERR(
                _cast<Ec>(value), "Python writeTag return code is", value));
        return {};
    };

    ccode = callPython(python);

    if (checkCallParent(ccode)) return Parent::writeTag(pTag);

    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Notify the filter the current document are read to close
//-------------------------------------------------------------------------
Error IPythonInstanceBase::closing() noexcept {
    Error ccode;

    LOGPIPE();

    if (!(m_pyMethods & PythonMethod::Closing)) return Parent::closing();

    auto python = localfcn()->Error {
        m_pyInstance.attr("closing")();
        return {};
    };

    ccode = callPython(python);

    if (checkCallParent(ccode)) return Parent::closing();

    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Notify the filter to close the current document
//-------------------------------------------------------------------------
Error IPythonInstanceBase::close() noexcept {
    Error ccode;

    LOGPIPE();

    if (!(m_pyMethods & PythonMethod::Close)) return Parent::close();

    auto python = localfcn()->Error {
        m_pyInstance.attr("close")();
        return {};
    };

    ccode = callPython(python);

    // Clear the target url and path
    m_targetObjectUrl = {};
    m_targetObjectPath.clear();

    if (checkCallParent(ccode)) return Parent::close();

    return ccode;
}
}  // namespace engine::store::pythonBase
