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

namespace engine::python {
namespace py = pybind11;

//-------------------------------------------------------------
/// @details
///     This will take a json::Value and return the correct
///     python value from it
//-------------------------------------------------------------
py::object getPythonValue(const json::Value &val) noexcept(false) {
    py::object ret;

    // Map it
    if (val.isObject())
        ret = py::cast(IJson(val));
    else if (val.isArray())
        ret = py::cast(IJson(val));
    else if (val.isString())
        ret = py::cast(val.asString().c_str());
    else if (val.isBool())
        ret = py::cast(val.asBool());
    else if (val.isInt())
        ret = py::cast(val.asInt());
    else if (val.isDouble())
        ret = py::cast(val.asDouble());
    else if (val.isNull())
        ret = py::none();
    else
        ret = py::cast(val);

    // Return it
    return ret;
}

//-------------------------------------------------------------
/// @details
///     This will take a python value and set the given
///     json::Value target to its value. This handles arrays
///     and objects as well, so:
///         self.IEndpoint.endpoint.taskConfig = {
///             key: 1,
///             collection: {
///                 key: 2
///             }
///         }
///     works as you would expect
//-------------------------------------------------------------
void setJsonValue(json::Value &target,
                  const py::object &value) noexcept(false) {
    if (value.is(py::none()))
        target = json::Value();
    else if (py::isinstance<py::str>(value))
        target = (Text)(value.cast<std::string>());
    else if (py::isinstance<py::bool_>(value))
        target = value.cast<bool>();
    else if (py::isinstance<py::int_>(value))
        target = value.cast<int>();
    else if (py::isinstance<py::float_>(value))
        target = value.cast<double>();
    else if (py::isinstance<json::Value>(value))
        target = value.cast<json::Value>();
    else if (py::isinstance<py::dict>(value)) {
        // Set it as an object
        target = json::Value(json::objectValue);

        // Iterate over dictionary items
        py::dict dict_value = value.cast<py::dict>();
        for (const auto &item : dict_value) {
            // Extract the key and value
            const auto &key = py::str(item.first);
            const auto &val = py::reinterpret_borrow<py::object>(item.second);

            // Create a new target for the key-value pair
            json::Value objectValue;

            // If it is already a json::Value, use it, otherwise recurse into it
            if (py::isinstance<IJson>(val))
                objectValue = val.cast<json::Value>();
            else
                setJsonValue(objectValue, val);

            // Insert the key-value pair into the object
            target[key.cast<std::string>()] = objectValue;
        }
    } else if (py::isinstance<py::list>(value)) {
        // Set it as an array
        target = json::Value(json::arrayValue);

        // Walk through all the passed values
        py::list list_value = value.cast<py::list>();
        for (const auto &item : list_value) {
            // Get the value
            const auto &val = py::reinterpret_borrow<py::object>(item);

            // Create a new item
            json::Value arrayValue;

            // If it is alreadt a json::Value, use it, otherise recurse into it
            if (py::isinstance<IJson>(val))
                arrayValue = item.cast<json::Value>();
            else
                setJsonValue(arrayValue, val);

            // Append it
            target.append(arrayValue);
        }
    } else
        throw std::invalid_argument("Unsupported value type");
}
}  // namespace engine::python
