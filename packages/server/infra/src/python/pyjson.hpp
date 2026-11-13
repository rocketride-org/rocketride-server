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

#pragma once

namespace engine::python {
namespace py = pybind11;

//-------------------------------------------------------------------------
/// @details
///		This class helps manage the python<->json interface
//-------------------------------------------------------------------------
class pyjson {
public:
    pyjson(py::dict &dict) : m_dict(dict) {}
    virtual ~pyjson() {}

    //-----------------------------------------------------------------
    ///	@details
    ///		Static function to take a json struct and turn it into a
    ///		python object
    //-----------------------------------------------------------------
    static py::object jsonToDict(const json::Value &value) {
        switch (value.type()) {
            case json::ValueType::nullValue:
                return py::none();
            case json::ValueType::intValue:
                return py::int_(value.asInt64());
            case json::ValueType::uintValue:
                return py::int_(value.asUInt64());
            case json::ValueType::realValue:
                return py::float_(value.asDouble());
            case json::ValueType::stringValue:
                return py::str(value.asString());
            case json::ValueType::booleanValue:
                return py::bool_(value.asBool());
            case json::ValueType::arrayValue: {
                py::list pyList;
                for (json::ArrayIndex i = 0, sz = value.size(); i < sz; ++i) {
                    const json::Value &arrayValue = value[i];
                    py::object pyValue = jsonToDict(arrayValue);
                    pyList.append(pyValue);
                }
                return pyList;
            }
            case json::ValueType::objectValue: {
                py::dict pyDict;
                for (auto &objectKey : value.getMemberNames()) {
                    const json::Value &objectValue = value[objectKey];
                    py::object pyValue = jsonToDict(objectValue);
                    pyDict[objectKey] = pyValue;
                }
                return pyDict;
            }
            default:
                throw APERR(Ec::OutOfRange,
                            "Unknown JSON value type:", value.type());
        }
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Static function to take a json struct and turn it into a
    ///		python dict
    //-----------------------------------------------------------------
    static json::Value dictToJson(const py::handle &obj) {
        if (obj.ptr() == nullptr || obj.is_none()) {
            json::Value value;
            return value;
        }
        if (py::isinstance<py::bool_>(obj)) {
            json::Value value{py::cast<bool>(obj)};
            return value;
        }
        if (py::isinstance<py::int_>(obj)) {
            json::Value value{py::cast<int64_t>(obj)};
            return value;
        }
        if (py::isinstance<py::float_>(obj)) {
            json::Value value{py::cast<double>(obj)};
            return value;
        }
        if (py::isinstance<py::str>(obj)) {
            json::Value value{py::cast<std::string>(obj)};
            return value;
        }
        if (py::isinstance<py::tuple>(obj) || py::isinstance<py::list>(obj)) {
            json::Value value(json::arrayValue);
            for (const py::handle elem : obj) {
                auto js = dictToJson(elem);
                value.append(js);
            }
            return value;
        }
        if (py::isinstance<py::dict>(obj)) {
            json::Value value(json::objectValue);
            for (const py::handle key : obj) {
                value[py::str(key).cast<std::string>()] = dictToJson(obj[key]);
            }
            return value;
        }

        // Pydantic v2 model — call .model_dump() to get a plain dict
        if (py::hasattr(obj, "model_dump")) {
            py::dict d = obj.attr("model_dump")();
            return dictToJson(d);
        }
        // Pydantic v1 model — call .dict() to get a plain dict
        if (py::hasattr(obj, "dict") && py::hasattr(obj, "__fields__")) {
            py::dict d = obj.attr("dict")();
            return dictToJson(d);
        }
        // Any callable (function, method, builtin, partial, etc.) — not
        // serializable
        if (PyCallable_Check(obj.ptr())) {
            json::Value value{"<method>"};
            return value;
        }

        // Numeric-like objects (e.g. Decimal) — try int first, then float
        if (PyNumber_Check(obj.ptr())) {
            // Try integer conversion first
            py::object intVal = py::reinterpret_steal<py::object>(
                PyNumber_Long(obj.ptr()));
            if (intVal.ptr() != nullptr) {
                json::Value value{py::cast<int64_t>(intVal)};
                return value;
            }
            PyErr_Clear();
            // Fall back to float
            py::object floatVal = py::reinterpret_steal<py::object>(
                PyNumber_Float(obj.ptr()));
            if (floatVal.ptr() != nullptr) {
                json::Value value{py::cast<double>(floatVal)};
                return value;
            }
            PyErr_Clear();
        }

        // Objects with __str__ (e.g. datetime, bytes, UUID) — serialize as string
        if (py::hasattr(obj, "__str__")) {
            json::Value value{py::str(obj).cast<std::string>()};
            return value;
        }

        throw std::runtime_error(
            "dictToJson not implemented for this type of object: " +
            py::repr(obj).cast<std::string>());
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Static function to merge a python dict to a json struct.
    ///     Update only missing json properties or existing ones.
    //-----------------------------------------------------------------
    static void updateJsonValues(json::Value &jObj, const py::dict &pyDict) {
        if (jObj.type() != json::ValueType::objectValue)
            throw APERR(Ec::InvalidParam, "JSON object expected");

        for (const auto &pr : pyDict) {
            auto key = pr.first.cast<std::string>();
            auto pyValue = pr.second;

            if (py::isinstance<py::bool_>(pyValue) &&
                (jObj[key].type() == json::ValueType::nullValue ||
                 jObj[key].type() == json::ValueType::booleanValue)) {
                jObj[key] = py::cast<bool>(pyValue);

            } else if (py::isinstance<py::int_>(pyValue) &&
                       (jObj[key].type() == json::ValueType::nullValue ||
                        jObj[key].type() == json::ValueType::intValue ||
                        jObj[key].type() == json::ValueType::uintValue ||
                        jObj[key].type() == json::ValueType::realValue)) {
                jObj[key] = py::cast<int64_t>(pyValue);

            } else if (py::isinstance<py::float_>(pyValue) &&
                       (jObj[key].type() == json::ValueType::nullValue ||
                        jObj[key].type() == json::ValueType::realValue)) {
                jObj[key] = py::cast<double>(pyValue);

            } else if (py::isinstance<py::str>(pyValue) &&
                       (jObj[key].type() == json::ValueType::nullValue ||
                        jObj[key].type() == json::ValueType::stringValue)) {
                jObj[key] = py::cast<std::string>(pyValue).c_str();

            } else if (py::isinstance<py::dict>(pyValue) &&
                       (jObj[key].type() == json::ValueType::nullValue ||
                        jObj[key].type() == json::ValueType::objectValue)) {
                if (jObj[key].type() == json::ValueType::nullValue)
                    jObj[key] = json::Value{json::ValueType::objectValue};

                updateJsonValues(jObj[key], pyValue.cast<py::dict>());

            } else if (py::isinstance<py::list>(pyValue) &&
                       (jObj[key].type() == json::ValueType::nullValue ||
                        jObj[key].type() == json::ValueType::arrayValue)) {
                // if new value is array -> overwrite previous value
                json::Value jsonArray{json::ValueType::arrayValue};
                for (const py::handle &item : pyValue.cast<py::list>())
                    jsonArray.append(dictToJson(item));
                jObj[key] = jsonArray;

            } else {
                throw APERR(Ec::InvalidParam, "Invalid JSON update value");
            }
        }
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Determines if the given key is specified in the dict
    ///	@param[in] key
    ///		The key to check
    //-----------------------------------------------------------------
    bool isMember(const char *key) {
        if (m_dict.is_none()) return false;

        return m_dict.contains(key);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Returns the value as a string
    ///	@param[in] key
    ///		The key to retrieve
    //-----------------------------------------------------------------
    Text asText(const char *key) {
        // See if it is a member
        if (!isMember(key)) return "";

        // Get reference to the item
        const auto &item = m_dict[key];

        // Check for none
        if (item.is_none()) return "";

        // Check for it being a string
        if (!py::isinstance<py::str>(item)) return "";

        // Get the string and convert to text
        return (py::cast<std::string>(item));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Returns the value as a number
    ///	@param[in] key
    ///		The key to retrieve
    //-----------------------------------------------------------------
    int64_t asInt64(const char *key) {
        // See if it is a member
        if (!isMember(key)) return 0;

        // Get reference to the item
        const auto &item = m_dict[key];

        // Check for none
        if (item.is_none()) return 0;

        // Check for it being a string
        if (!py::isinstance<py::int_>(item)) return 0;

        // Get the numberic value
        return py::cast<int64_t>(item);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Returns the value as a bool
    ///	@param[in] key
    ///		The key to retrieve
    //-----------------------------------------------------------------
    int64_t asBool(const char *key) {
        // See if it is a member
        if (!isMember(key)) return false;

        // Get reference to the item
        const auto &item = m_dict[key];

        // Check for none
        if (item.is_none()) return false;

        // Check for it being a string
        if (!py::isinstance<py::bool_>(item)) return false;

        // Get the numberic value
        return py::cast<bool>(item);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Returns the value as a json
    ///	@param[in] key
    ///		The key to retrieve
    //-----------------------------------------------------------------
    json::Value asJson(const char *key) {
        // See if it is a member
        if (!isMember(key)) return {};

        // Get reference to the item
        const auto &item = m_dict[key];

        // Convert the item to json
        return dictToJson(item);
    }

private:
    py::dict &m_dict;
};

}  // namespace engine::python
