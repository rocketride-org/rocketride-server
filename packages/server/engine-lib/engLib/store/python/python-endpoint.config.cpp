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
//-----------------------------------------------------------------
/// @details
///		Make static, finalized configs
///	@param[out]	key
///		Receives the unique configuration key for this endpoint
//-----------------------------------------------------------------
Error IPythonEndpointBase::getConfigSubKey(Text &key) noexcept {
    // End the python endpoint
    const auto python = localfcn()->Error {
        // If the driver does not have this, it will be
        // empty and set to *, which will allow only one driver
        if (!py::hasattr(m_pyEndpoint, "getConfigSubKey")) return {};

        // Call the function
        auto subkey = m_pyEndpoint.attr("getConfigSubKey")();

        // If no return, call the parent
        if (subkey.is_none()) return Parent::getConfigSubKey(key);

        // Cast to a string
        key = py::cast<std::string>(subkey);
        return {};
    };

    // Call it
    return callPython(python);
}

//-----------------------------------------------------------------
/// @details
///		Validate the the service configuration. This should pretty
///		much not fail, but rather errors and warnings should be
///		place in the errors result. If it does return an error, the
///		configure task will put that error in errors automatically
///		and return a successful outcome for the task
///	@param[in]	syntaxOnly
///		Perform a syntax check only
//-----------------------------------------------------------------
Error IPythonEndpointBase::validateConfig(bool syntaxOnly) noexcept {
    // Call the parent first
    if (auto ccode = Parent::validateConfig(syntaxOnly)) return ccode;

    // End the python endpoint
    const auto python = localfcn()->Error {
        // If the driver has it, call it, throws on error
        if (py::hasattr(m_pyEndpoint, "validateConfig"))
            m_pyEndpoint.attr("validateConfig")(syntaxOnly);
        return {};
    };

    // Call it
    return callPython(python);
}

//-----------------------------------------------------------------
/// @details
///		Congigure the list of the pipe stack filters
///	@param[out]	filters
///		The list of the filters required by endpoint
//-----------------------------------------------------------------
Error IPythonEndpointBase::getPipeFilters(IPipeFilters &filters) noexcept {
    Error ccode;

    // Python getPipeFilters
    const auto python = localfcn()->Error {
        if (py::hasattr(m_pyEndpoint, "getPipeFilters")) {
            // Get filters from python endpoint
            pybind11::object pyResult = m_pyEndpoint.attr("getPipeFilters")();

            // Ignore anything except a list
            if (!py::isinstance<py::list>(pyResult)) return {};

            // Gete the list of filters
            py::list pyFilters = pyResult.cast<py::list>();

            // Loop through the Python filters
            for (auto &item : pyFilters) {
                if (py::isinstance<py::str>(item)) {
                    // If the item is a string, cast it to std::string and
                    // insert as Text
                    filters.emplace_back(Text(py::cast<std::string>(item)));
                } else if (py::isinstance<py::dict>(item)) {
                    // If the item is a dict, convert it to json::Value using
                    // pyjson::dictToJson
                    json::Value jsonValue =
                        engine::python::pyjson::dictToJson(item);
                    filters.emplace_back(
                        jsonValue);  // Add a copy of jsonValue to the filters
                } else {
                    throw APERR(Ec::InvalidParam,
                                "getPipeFilters is not a string or a dict");
                }
            }
        }

        return {};
    };

    ccode = callPython(python);

    if (checkCallParent(ccode)) return Parent::getPipeFilters(filters);

    return ccode;
}
}  // namespace engine::store::pythonBase
