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

#pragma once

namespace pybind11::detail {
namespace py = pybind11;

//-------------------------------------------------------------
/// @details
///     This caster will convert an IJson or py::dict <=> json::Value
//-------------------------------------------------------------
namespace json = ap::json;
using engine::python::IJson;
template <>
struct type_caster<json::Value> {
public:
    PYBIND11_TYPE_CASTER(json::Value, _("json::Value"));

    //-------------------------------------------------------------
    /// @details
    ///     Cast to a json::Value
    //-------------------------------------------------------------
    bool load(py::handle src, bool) {
        // If this is a dict
        if (py::isinstance<py::dict>(src)) {
            // Create an empty value
            value = json::Value();

            // Get the src as a py::dict
            py::dict dict = src.cast<py::dict>();

            // Set the value from the dict
            engine::python::setJsonValue(value, dict);
            return true;
        }

        // If this a wrapped json::Value object
        if (py::isinstance<IJson>(src)) {
            // Get the IJson
            auto &obj = py::cast<IJson &>(src);

            // Get the ptr to the wrapped value
            auto ptr = obj.getJsonValue();

            // Save it as a reference
            value = *ptr;
            return true;
        }

        // Don't understand this
        return false;
    }

    //-------------------------------------------------------------
    /// @details
    ///     Cast a json::Value to a py::dict
    //-------------------------------------------------------------
    static py::handle cast(const json::Value &src,
                           py::return_value_policy policy, py::handle parent) {
        // Get the value
        auto obj = engine::python::getPythonValue(src);

        // Return it and release the refcount
        return obj.release();
    }
};

//-------------------------------------------------------------
/// @details
///     This caster will convert an Text <=> py::str
//-------------------------------------------------------------
using ap::Text;
template <>
struct type_caster<Text> {
public:
    PYBIND11_TYPE_CASTER(Text, _("str"));

    // Conversion from Python to C++ (py::str to Text, which is std::string)
    bool load(py::handle src, bool) {
        if (py::isinstance<py::str>(src)) {
            value = py::cast<std::string>(
                src);  // Converts Python str to std::string
            return true;
        }
        return false;
    }

    // Conversion from C++ to Python (Text to py::str)
    static py::handle cast(const Text &src, py::return_value_policy policy,
                           py::handle parent) {
        return py::str(src)
            .release();  // Converts std::string (Text) to Python str
    }
};

//-------------------------------------------------------------
/// @details
///     This caster will convert an Error <=> none
///     Note that on return to python (the cast function), will
///     throw the error if an error occured. Otherwise it
///     will return none
//-------------------------------------------------------------
using ap::Error;
template <>
struct type_caster<Error> {
public:
    PYBIND11_TYPE_CASTER(Error, _("error"));

    // Conversion from Python to C++
    bool load(py::handle src, bool) {
        value = {};
        return true;
    }

    // Conversion from C++ to Python
    static py::handle cast(const Error &ccode, py::return_value_policy policy,
                           py::handle parent) {
        if (ccode) throw ccode;
        return py::none();
    }
};
}  // namespace pybind11::detail
