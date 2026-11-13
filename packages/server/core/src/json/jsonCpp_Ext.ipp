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

//
//	Inline additions to the json value object
//

// Load from a json string
Error Value::parse(TextView jsonString) noexcept {
    // Clear anything we already have
    *this = nullValue;

    // Setup a read to parse it
    return _callChk([&]() noexcept(false) -> Error {
        Reader reader;
        if (!reader.parse(jsonString.data(),
                          jsonString.data() + jsonString.size(), *this, true))
            return APERRL(Json, Ec::InvalidJson,
                          reader.getFormatedErrorMessages());
        return {};
    });
}

// Access an array index from a text view key
const Value &Value::operator[](TextView key) const noexcept(false) {
    if (auto *found = find(&key.front(), &key.front() + key.size()))
        return *found;
    return nullSingleton();
}

// Access an array index from a text view key
Value &Value::operator[](TextView key) noexcept(false) {
    if (key)
        return resolveReference(&key.front(), &key.front() + key.size());
    else
        return resolveReference(nullptr, nullptr);
}

// Access an array index from a text view key
bool Value::isMember(TextView key) const noexcept {
    return isMember(&key.front(), &key.front() + key.size());
}

// Converts a Json structure to a text string
Text Value::stringify(bool bPrettyPrint) const noexcept {
    // StyledWriter if pretty
    if (bPrettyPrint) {
        StyledWriter writer;
        return writer.write(*this);
    }

    // FastWriter if marshaling over rpc etc.
    FastWriter writer;
    return Text{writer.write(*this)}.trim();
}

// Get the Json value given the path
bool Value::getKey(TextView path, Value **ppValue,
                   ValueType defaultValueType) noexcept {
    // Split the path so we can walk it
    auto fields = string::split(path, ".");

    // Init
    auto pComponent = this;

    // If there isn't a path, we are just going to return the root level
    if (fields.size() < 1) {
        *ppValue = pComponent;
        return true;
    }

    // Walk the list up to the final terminal
    for (size_t index = 0; index < fields.size() - 1; index++) {
        // Get the new component
        auto pNext = &pComponent->operator[](fields[index]);

        // If the key isn't there
        if (pNext->type() == ValueType::nullValue) {
            // Are we supposed to create it
            if (defaultValueType == ValueType::nullValue) {
                // Nope, return the parent
                *ppValue = pComponent;
                return false;
            }
        }

        // If this is not an object type - it is not a container, create
        // a container
        if (pNext->type() != objectValue) {
            Value container(ValueType::objectValue);
            pNext->swap(container);
        }

        // Move down
        pComponent = pNext;
    }

    // Get the final key
    auto &finalKey = fields.back();

    // If this value is not present
    if (pComponent->type() != ValueType::objectValue ||
        !pComponent->isMember(finalKey)) {
        // Does not exist, are we supposed to create it?
        if (defaultValueType != ValueType::nullValue) {
            // Create the key
            pComponent->operator[](finalKey) = defaultValueType;

            // Return a ptr to the key
            *ppValue = &pComponent->operator[](finalKey);
        } else {
            // Nope, return the parent
            *ppValue = pComponent;
        }
        return false;
    }

    // Get the final component
    *ppValue = &pComponent->operator[](finalKey);

    // We properly mapped it
    return true;
}

// Get a string from the json
bool Value::getStr(TextView path, Text &str) noexcept(false) {
    // Map the key, return the default if not found
    auto val = getKey(path);
    if (!val) return false;

    // Get the value as a string
    str = val->asString();
    return true;
}

// Walks the entire json tree and expands any variables
void Value::expandTree(const util::Vars &vars) noexcept(false) {
    auto expandVal = [&](auto &val) noexcept {
        if (val.isString()) {
            Text str = val.asString();
            val = vars.expandInplace(str);
        }
    };

    for (auto &val : *this) {
        expandVal(val);
        val.expandTree(vars);
    }
}

// Get a text vector from the Json
TextVector Value::textVector(TextView path, TextVector defaultValue) const
    noexcept(false) {
    // Map the key, return the default if not found
    auto val = getKey(path);
    if (!val) return _mv(defaultValue);

    // If it is not an array, exit
    if (val->type() != arrayValue) return _mv(defaultValue);

    // Add the values as strings
    TextVector result;
    for (ArrayIndex index = 0; index < val->size(); index++) {
        // Get the string
        auto str = const_cast<Value *>(val)->operator[](index).asString();
        result.emplace_back(_mv(str));
    }

    // Return it
    return result;
}

// Get a subtree as a Value object
Value Value::sub(TextView path) noexcept {
    // Map the key, create it if it does not exist
    Value *val;
    getKey(path, &val, ValueType::objectValue);
    ASSERT(val);
    return *val;
}

// Get a subtree as a Value object
std::vector<Value> Value::vector(TextView path) const noexcept(false) {
    // Map the key, return the default if not found
    auto val = getKey(path);
    if (!val) return {};

    // If it is not an array, exit
    if (val->type() != ValueType::arrayValue) return {};

    // Add the values sub branches
    std::vector<Value> result;
    for (ArrayIndex index = 0; index < val->size(); index++)
        result.emplace_back(const_cast<Value *>(val)->operator[](index));
    return result;
}

// Output this key to the console
void Value::output(TextView message) const noexcept {
    // If there is a message, output it
    if (message) log::write(_location, "{}", message);

    // Now, output the string
    log::write(_location, "{}", toStyledString());
}

// Merge the given key
Value &Value::merge(TextView path, const Value &src) noexcept {
    // Function to merge two subtrees
    Function<void(Value &, const Value &)> mergeSubtree;
    mergeSubtree = [&mergeSubtree](Value &dst, const Value &src) noexcept {
        // If src is not an object, just set the value and done
        if (!src.isObject()) {
            dst = src;
            return;
        }

        auto keys = src.keys();
        keys;

        // If dst is not an object, set it to an object
        if (!dst.isObject()) dst = Value(ValueType::objectValue);

        // Merge this branch
        for (auto &&key : src.keys()) mergeSubtree(dst[key], src[key]);
    };

    // Based on the type
    Value *pDst;
    switch (src.type()) {
        case ValueType::objectValue:
            // Get a ptr to the destination point - create it if it isn't there
            getKey(path, &pDst, ValueType::objectValue);

            // Merge the subtrees
            // create it
            mergeSubtree(*pDst, src);
            break;

        default:
            // Get a ptr to the destination point - create it if it isn't there
            getKey(path, &pDst, src.type());
            *pDst = src;
            break;
    }

    return *this;
}
