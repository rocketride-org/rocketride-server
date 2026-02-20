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

namespace engine::python {
namespace py = pybind11;

//-------------------------------------------------------------------------
/// @details
///     Utility functions to convert a json::Value to a python value or
///     a python value to a json value. Handles shallow and deep conversion
//-------------------------------------------------------------------------
py::object getPythonValue(const json::Value &val) noexcept(false);
void setJsonValue(json::Value &target, const py::object &value) noexcept(false);

//-------------------------------------------------------------------------
/// Json interator
///     Iterator returned from the iter() function in IJson. This is used
///     so python can use
///         for k in IJson
//-------------------------------------------------------------------------
class IJsonIterator {
public:
    //-------------------------------------------------------------
    /// @details
    ///     Beginning and end of the iteration
    //-------------------------------------------------------------
    json::Value::iterator current;
    json::Value::iterator end;

    //-------------------------------------------------------------
    /// @details
    ///     Constructs the iterator given the beginning, ending and
    ///     the underlying value
    //-------------------------------------------------------------
    IJsonIterator(json::Value::iterator begin, json::Value::iterator end,
                  json::Value &value)
        : current(begin), end(end), m_value(value) {}

    //-------------------------------------------------------------
    /// @details
    ///     Gets the next item
    //-------------------------------------------------------------
    py::object next() {
        // If we hit the end, then done
        if (current == end)
            throw py::stop_iteration();  // Signal end of iteration

        // If the item is an array, get the item at that index
        if (m_value.isArray()) {
            // Return it as a python value
            py::object result = getPythonValue(*current);

            // Advance it and return
            ++current;
            return result;
        }

        // If the items is an object, return the key
        if (m_value.isObject()) {
            // Get the key
            auto curr = current.key();

            // Convert to a string
            py::object result = py::str(curr.asString());  // Get the key

            // Advance it and return
            ++current;
            return result;
        }

        throw std::invalid_argument("Invalid iterator type");
    }

private:
    //-------------------------------------------------------------
    /// @details
    ///     Private value so we can determine which type of
    ///     iteration - array or object
    //-------------------------------------------------------------
    json::Value &m_value;
};

//-------------------------------------------------------------------------
//
//  Python wrapper for json::Value
//
// This class is a bit tricky so it can work with the debugpy correctly.
// Normally, it woud be nice to just inherit from py::dict or
// collections.abc.Mapping but pybind has real problems with this. So,
// we essentially have to trick the debugger into doing the right thing. We
// do this by declaring our keys as attributes, return them with the __dir__
// function, return our items in '...' so they look like a dict items. Then,
// if __getattr__ is given a quoted string, we know it is a dict type item
// that we need to look up in the json::Value. If it is non-quoted, it is
// a normal attribute we have to look up. We have to define these methods
// as follows:
//
//      __dir__     Returns a list of attributes - built from the json::Value
//                  keys
//
//      __getattr__ If the string is quoted, remote the quotes and look for
//                  the value in the json::Value. We do this so the debugger
//                  not only displays the key name in quotes, but its
//                  value as well.
//                  If the string is unquoted, it is not one of our values
//                  and __getattribute__ should have found it. We just
//                  raise a key not found error and bail out
//
//-------------------------------------------------------------------------
class IJson {
private:
    //-------------------------------------------------------------
    /// This is used in the case no explicit json::Value is given
    /// like when we init from a py::dict or we use the default
    /// constructor. We must point to something and here it is...
    //-------------------------------------------------------------
    json::Value m_value = json::Value(json::objectValue);

    //-------------------------------------------------------------
    /// Pointer to the wrapped json value
    //-------------------------------------------------------------
    json::Value *m_pjson;

public:
    //-------------------------------------------------------------
    /// @details
    ///     Default constructor - construcs an empty none value
    ///     in the internal cache. Used to create an empty IJson
    //-------------------------------------------------------------
    IJson() {
        // LOGX(Lvl::Always, "Constructing empty IJson");
        m_pjson = &m_value;
    }

    //-------------------------------------------------------------
    /// @details
    ///     Constructs an IJson from a specific json::Value ptr.
    ///     This wraps an existing value. Used frequently.
    //-------------------------------------------------------------
    IJson(const json::Value *pValue) {
        // LOGX(Lvl::Always, "Constructing IJson from json::Value *");
        m_pjson = const_cast<json::Value *>(pValue);
    }

    //-------------------------------------------------------------
    /// @details
    ///     Constructs an IJson from a specific json::Value
    ///     reference. This wraps an existing value. Used
    ///     frequently.
    //-------------------------------------------------------------
    IJson(const json::Value &value) {
        // LOGX(Lvl::Always, "Constructing IJson from json::Value &");
        m_pjson = &(const_cast<json::Value &>(value));
    }

    //-------------------------------------------------------------
    /// @details
    ///     Constructs an IJson from a python dict. This is used
    ///     like t = IJson({"A": 1})
    //-------------------------------------------------------------
    IJson(const py::dict &value) {
        // LOGX(Lvl::Always, "Constructing IJson from dict");
        setJsonValue(m_value, value);
        m_pjson = &m_value;
    }

    //-------------------------------------------------------------
    /// @details
    ///     Constructs an IJson from another IJson value
    //-------------------------------------------------------------
    IJson(const IJson &value) {
        // LOGX(Lvl::Always, "Constructing IJson from IJson");
        m_pjson = const_cast<IJson &>(value).getJsonValue();
    }

    //-------------------------------------------------------------
    /// @details
    ///     Returns a ptr to the underlying json::Value being
    ///     wrapped
    //-------------------------------------------------------------
    json::Value *getJsonValue() { return m_pjson; }

    //-------------------------------------------------------------
    /// @details
    ///     Given an object, returns a key string
    //-------------------------------------------------------------
    std::string getKey(const py::object &obj) {
        // If it is a string or a number
        if (py::isinstance<py::str>(obj) || py::isinstance<py::int_>(obj) ||
            py::isinstance<py::float_>(obj))
            return py::str(obj);

        // Something else
        throw std::runtime_error("key error");
    }

    //-------------------------------------------------------------
    /// @details
    ///     Given an object, returns an index
    //-------------------------------------------------------------
    unsigned getIndex(const py::object &obj) {
        // If it is a number
        if (py::isinstance<py::int_>(obj)) return py::cast<unsigned>(obj);

        // If it is a string
        if (py::isinstance<py::str>(obj)) {
            try {
                return std::stoi(py::cast<py::str>(obj));
            } catch (...) {
                throw std::runtime_error("list indices must be an integer");
            }
        }

        // Something else...
        throw std::runtime_error("list indices must be an integer");
    }

    //-------------------------------------------------------------
    /// @details
    ///     Return a vector of the keys. pybind will convert the
    ///     vector to python automatically
    //-------------------------------------------------------------
    std::vector<std::string> keys() {
        std::vector<std::string> keys;

        // If its null, no keys
        if (m_pjson->isNull()) return keys;

        // If it's not an object, invalid
        if (!m_pjson->isObject())
            throw std::invalid_argument("Value must be an object to get keys");

        // Obtain the key names and copy them over
        for (const auto &member : m_pjson->getMemberNames())
            keys.push_back(member);

        // Return the ketys
        return keys;
    }

    //-------------------------------------------------------------
    /// @details
    ///     Return a vector of the values. pybind will convert the
    ///     vector to python automatically. Note that the values
    ///     may be complex objects, such as a reference to another
    ///     json::Value container
    //-------------------------------------------------------------
    py::list values() {
        // Directly create a vector of Python tuples
        py::list values;

        // If its null, no values
        if (m_pjson->isNull()) return values;

        // If it's not an object, invalid
        if (!m_pjson->isObject())
            throw std::invalid_argument(
                "Value must be an object to get values");

        // Get the keys of the JSON object
        auto keys = m_pjson->getMemberNames();

        // Enumerate all the keys and get their values
        for (auto it = keys.begin(); it != keys.end(); ++it) {
            const std::string key = *it;
            const py::object value = getPythonValue((*m_pjson)[key]);

            // Add each (key, value) tuple to the list
            values.append(value);
        }

        // Return the values
        return values;
    }

    //-------------------------------------------------------------
    /// @details
    ///     Return a vector of tuples with the key/value pair
    //-------------------------------------------------------------
    py::list items() {
        // Directly create a vector of Python tuples
        py::list keyValuePairs;

        // If its null, no values
        if (m_pjson->isNull()) return keyValuePairs;

        // If it's not an object, invalid
        if (!m_pjson->isObject())
            throw std::invalid_argument(
                "Value must be an object to iterate over");

        // Get the keys of the JSON object
        auto keys = m_pjson->getMemberNames();

        // Walk the keys, get the values
        for (auto it = keys.begin(); it != keys.end(); ++it) {
            const std::string key = *it;
            const py::object value = getPythonValue((*m_pjson)[key]);

            // Add each (key, value) tuple to the list
            keyValuePairs.append(py::make_tuple(py::str(key), value));
        }

        // Return the tuples of key/value pairs
        return keyValuePairs;
    }

    //-------------------------------------------------------------
    /// @details
    ///     Return a string representation of the json::Value
    //-------------------------------------------------------------
    std::string repr() {
        // If its none, just return none
        if (m_pjson->isNull()) return "None";

        // Use our built in stringify
        return m_pjson->stringify(false);
    }

    //-------------------------------------------------------------
    /// @details
    ///     Given a key this will return the value if the item
    ///     exists, or the default value
    //-------------------------------------------------------------
    py::object get(const std::string &key, py::object def) {
        // If this is a null object, return the default
        if (m_pjson->isNull()) return def;

        // Otherwise, it must be an object
        if (!m_pjson->isObject())
            throw std::invalid_argument("Value must be an object to use get");

        // If we don't have this member, return the default
        // which defaults to None
        if (!m_pjson->isMember((Text)key)) return def;

        // Get the value
        auto &val = (*m_pjson)[key];

        // Return it
        return getPythonValue(val);
    }

    //-------------------------------------------------------------
    /// @details
    ///     Given a key this will return True if the key exists
    ///     False if not
    //-------------------------------------------------------------
    bool contains(const py::object &item) {
        // If its null, con't be there
        if (m_pjson->isNull()) return false;

        // Easy, look for the key
        if (m_pjson->isObject()) {
            auto key = getKey(item);
            return m_pjson->isMember((Text)key);
        }

        // Array "contains" look for the value
        if (m_pjson->isArray()) {
            // Examine each it
            for (unsigned index = 0; index < m_pjson->size(); index++) {
                // Get the array item
                auto &arrayItem = (*m_pjson)[index];

                // If this is an int type
                if (arrayItem.isInt()) {
                    // If the parameters is not an integral, skip it
                    if (!py::isinstance<py::int_>(item)) continue;

                    // If this is not it, skip it
                    if (arrayItem.asInt() ==
                        _cast<int>(py::cast<py::int_>(item)))
                        return true;
                }

                // If this is a string type
                if (arrayItem.isString()) {
                    // If the parameters is not an integral, skip it
                    if (!py::isinstance<py::str>(item)) continue;

                    // Get the item (what we are looking for) and the value
                    // (what this is)
                    std::string itemString = py::str(item);
                    std::string valueString = arrayItem.asString();

                    // If this is not it, skip it
                    if (valueString == itemString) return true;
                }

                // Types cannot be matched
                continue;
            }
        }

        return false;
    }

    //-------------------------------------------------------------
    /// @details
    ///     Create an iterator
    //-------------------------------------------------------------
    IJsonIterator iter() {
        // If is not an object or array, return an empty iterator
        if (!m_pjson->isObject() && !m_pjson->isArray())
            return IJsonIterator(m_pjson->end(), m_pjson->end(), *m_pjson);

        // Return an iterator
        return IJsonIterator(m_pjson->begin(), m_pjson->end(), *m_pjson);
    }

    //-------------------------------------------------------------
    /// @details
    ///     Given a key, delete an item
    //-------------------------------------------------------------
    void delitem(const py::object &item) {
        // If this is null, done
        if (m_pjson->isNull()) return;

        // If this is an object
        if (!m_pjson->isObject()) {
            // Get the key as a string - json only has string keys
            const auto key = getKey(item);

            // Attempt to remove the key from the JSON object
            if (!m_pjson->isMember((Text)key))
                throw std::invalid_argument("Key not found");

            // Remove the member
            m_pjson->removeMember((Text)key);
            return;
        }

        if (!m_pjson->isArray()) {
            // Get the index as a nuber
            const auto index = getIndex(item);

            // Check the index
            if (index >= m_pjson->size())
                throw std::invalid_argument("list index out of range");

            // Remove it
            m_pjson->removeIndex(index);
            return;
        }

        throw std::invalid_argument("Value must be an object to delete by key");
    }

    //-------------------------------------------------------------
    /// @details
    ///     Given a key this will set the json:Value to the given
    ///     value. Note that the value is converted a real json
    ///     value.
    //-------------------------------------------------------------
    void setitem(py::object &key, py::object value) {
        // If the key is a string or a number
        if (py::isinstance<py::str>(key)) {
            // If the value is null, initialize it as an object
            if (m_pjson->isNull())
                m_pjson->operator=(json::Value(json::objectValue));
        } else if (py::isinstance<py::int_>(key) ||
                   py::isinstance<py::float_>(key)) {
            // If the value is null, initialize it as an object
            if (m_pjson->isNull())
                m_pjson->operator=(json::Value(json::arrayValue));
        } else {
            // Must be a number or a string
            throw std::invalid_argument(
                "Key must be either a number or a string");
        }

        // Ensure the target is an object
        if (m_pjson->isObject()) {
            // Get the item key
            auto itemKey = getKey(key);

            // Create the value
            auto item = json::Value();

            // Get the items value
            setJsonValue(item, value);

            // Save it
            (*m_pjson)[itemKey] = item;
            return;
        }

        if (m_pjson->isArray()) {
            // Get the index
            auto index = getIndex(key);

            // Create a value
            auto item = json::Value();

            // Get the items value
            setJsonValue(item, value);

            // Ensure the array has all the indices up to and including 'index'
            unsigned currentSize = m_pjson->size();
            if (index >= currentSize) {
                // If the array is smaller than 'index', add null values to fill
                // the gap
                m_pjson->resize(index + 1);
            }

            // Save it
            (*m_pjson)[index] = item;
        }

        throw std::invalid_argument("Invalid type");
    }

    //-------------------------------------------------------------
    /// @details
    ///     Given a key this will return the value
    //-------------------------------------------------------------
    py::object getitem(py::object &key) {
        // If this is an object
        if (m_pjson->isObject()) {
            // Get the item key
            auto itemKey = getKey(key);

            // If we don't have this member, return none
            if (!m_pjson->isMember((Text)itemKey))
                throw std::invalid_argument("Invalid key");

            // Get the value
            auto &val = (*m_pjson)[itemKey];

            // Return it
            return getPythonValue(val);
        }

        // If this is an array
        if (m_pjson->isArray()) {
            // Get the index
            auto itemIndex = getIndex(key);

            // Check in range
            if (itemIndex >= m_pjson->size())
                throw std::invalid_argument("list index out of range");

            // Get the value
            auto &val = (*m_pjson)[itemIndex];

            // Return it as a python value
            return getPythonValue(val);
        }

        throw std::invalid_argument("Value must be an object or an array");
    }

    //-------------------------------------------------------------
    /// @details
    ///     Return the length of the collection - number of keys
    //-------------------------------------------------------------
    unsigned len() {
        // If this is a null value, 0 length
        if (m_pjson->isNull()) return 0;

        // If this is an object or an array, it has a size
        if (m_pjson->isArray() || m_pjson->isObject()) return m_pjson->size();

        // A scalar does not have a length
        throw std::invalid_argument(
            "Value must be an object or an array to get the length");
    }

    //-------------------------------------------------------------
    /// @details
    ///     Clear the object
    //-------------------------------------------------------------
    void clear() {
        // Create a value
        auto item = json::Value(json::objectValue);
        m_pjson->operator=(_mv(item));
    }

    //-------------------------------------------------------------
    /// @details
    ///     Return the length of the collection - number of keys
    //-------------------------------------------------------------
    void append(py::object value) {
        // If the value is null or an object, initialize it as an array
        if (m_pjson->isNull() || m_pjson->isObject())
            m_pjson->operator=(json::Value(json::arrayValue));

        // If this is an object or an array, it has a size
        if (!m_pjson->isArray())
            throw std::invalid_argument("Value must be an an array to append");

        // Create a value
        auto item = json::Value(json::objectValue);

        // Get the items value
        setJsonValue(item, value);

        // Append it
        m_pjson->append(item);
    }

    //-------------------------------------------------------------
    /// @details
    ///     Inserts a new item into the array at the given index
    //-------------------------------------------------------------
    void insert(py::int_ index, py::object value) {
        // If the value is null, initialize it as an array
        if (m_pjson->isNull())
            m_pjson->operator=(json::Value(json::arrayValue));

        // If this is an object or an array, it has a size
        if (!m_pjson->isArray())
            throw std::invalid_argument("Value must be an an array to insert");

        // Get the index
        unsigned insertIndex = index;

        // Create a value
        auto item = json::Value();

        // Get the items value
        setJsonValue(item, value);

        // Insert the item at the desired index (e.g., index 1)
        json::Value newArray(json::arrayValue);

        // Move items up to the insertion index
        for (unsigned i = 0; i < insertIndex; ++i)
            newArray.append(_mv((*m_pjson)[i]));

        // Add the new item
        newArray.append(_mv(item));

        // Copy the remaining items
        for (unsigned i = insertIndex; i < m_pjson->size(); ++i)
            newArray.append(_mv((*m_pjson)[i]));

        // Replace the old array
        m_pjson->operator=(_mv(newArray));
        return;
    }

    //-------------------------------------------------------------
    /// @details
    ///     Remove an item from the array at the given index
    //-------------------------------------------------------------
    void remove(py::int_ index) {
        // Get the index
        unsigned removeIndex = index;

        // Create a new array
        json::Value newArray(json::arrayValue);

        // Copy all elements except the one to be removed
        for (unsigned i = 0; i < m_pjson->size(); ++i) {
            if (i != removeIndex) newArray.append((*m_pjson)[i]);
        }

        // Replace the old array
        m_pjson->operator=(_mv(newArray));
        return;
    }

    //-------------------------------------------------------------
    /// @details
    ///     This is the tricky part - __dir__ returns a vector of
    ///     the 'attributes' of the collection. Although this can
    ///     be called by any function, it is mainly used by the
    ///     debugger. We will take all the keys in the object,
    ///     then add quotes around them so the debugger will
    ///         'key' = value, instead of key = value.
    ///     This is important for the user of the class to recognize
    ///     that they don't use obj.syntax, but rather obj['key']
    ///     syntax
    //-------------------------------------------------------------
    std::vector<std::string> dir() {
        std::vector<std::string> keys;

        // If this is an object
        if (m_pjson->isObject()) {
            for (const auto &member : m_pjson->getMemberNames())
                keys.push_back('\'' + member + '\'');
            return keys;
        }

        // If this is an array
        if (m_pjson->isArray()) {
            for (unsigned index = 0; index < m_pjson->size(); index++)
                keys.push_back(std::to_string(index));
            return keys;
        }

        // Invalid - return an empty set
        return keys;
    }

    //-------------------------------------------------------------
    /// @details
    ///     This is the called by python if the regular
    ///     __getattribute__ call failed to find the correct
    ///     attribute, which in the case of a quoted key from the
    ///     __dict__, it won't find. So, remove the quotes, look it
    ///     up in the json::Value, and if not preset, throw a
    ///     key not found error
    //-------------------------------------------------------------
    py::object getattr(const std::string &key) {
        // If this is an object, get the quoted string
        if (m_pjson->isObject()) {
            // Check if the first and last characters are quotes and trim them
            size_t start = 0;
            size_t end = key.size() - 1;

            // Determine if this is a quoted string - a string key
            bool isQuoted = false;
            if (key[start] == '\'') {
                start++;
                isQuoted = true;
            }

            // Trim trailing quote (if any)
            if (key[start] == '\'') {
                end--;
                isQuoted = true;
            }

            // If this was quoted (a json::Value reference)
            if (isQuoted) {
                // Return the substring with quotes removed
                auto tKey = key.substr(start, end - start);

                // Make sure it is an object
                if (!m_pjson->isObject())
                    throw std::invalid_argument(
                        "Value must be an object to get by key");

                // If quoted, check if the key exists in the JSON object
                if (!m_pjson->isMember((Text)tKey)) return py::none();

                // Get the value from the JSON object
                auto &val = (*m_pjson)[tKey];
                return getPythonValue(val);
            }
        }

        // If this is an array
        if (m_pjson->isArray()) {
            // Get the index
            int index = std::stoi(key);

            // Get the value from the JSON object
            auto &val = (*m_pjson)[index];
            return getPythonValue(val);
        }

        // Raise a KeyError if the attribute is not found
        throw std::invalid_argument("Attribute not found");
    }

    //-------------------------------------------------------------
    /// @details
    ///     Convert to a python dict
    //-------------------------------------------------------------
    py::object toDictRecurse(json::Value *json_obj) {
        if (json_obj->isObject()) {
            py::dict result;
            for (const auto &item : json_obj->getMemberNames()) {
                auto &value = (*json_obj)[item];
                result[py::str(item)] = toDictRecurse(&value);
            }
            return result;
        } else if (json_obj->isArray()) {
            py::list result;
            for (unsigned index = 0; index < json_obj->size(); index++) {
                auto &value = (*json_obj)[index];
                result.append(toDictRecurse(&value));
            }
            return result;
        } else {
            return getPythonValue(*json_obj);
        }
    }

    py::dict toDict() {
        // If its null, just return a dict
        if (m_pjson->isNull()) return py::dict();

        // Recurse into it
        auto result = toDictRecurse(m_pjson);
        return result;
    }
};
}  // namespace engine::python
