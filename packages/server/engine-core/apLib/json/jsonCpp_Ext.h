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
//	JSON extensions
//
#pragma once

// Core api extensions
template <typename TraitsT>
Value(string::StrView<char, TraitsT> view) noexcept;

Value &operator[](TextView key) noexcept(false);
const Value &operator[](TextView key) const noexcept(false);

Error parse(TextView jsonString) noexcept;
Value sub(TextView path) noexcept;
Value &merge(TextView path, const Value &src) noexcept;
Value &merge(const Value &src) noexcept { return merge({}, src); }
bool isMember(TextView key) const noexcept;

Text stringify(bool bPrettyPrint = false) const noexcept;
TextVector textVector(TextView path, TextVector defaultValue = {}) const
    noexcept(false);
std::vector<Value> vector(TextView path) const noexcept(false);
void output(TextView message = {}) const noexcept;

// Get the keys for the object type
template <typename ContainerT = TextVector>
ContainerT keys(TextView path = {}) const noexcept {
    if (auto val = getKey(path)) {
        return util::transform<ContainerT>(
            val->getMemberNames(), [](auto &key) noexcept { return _mv(key); });
    }

    return {};
}

// For easier const correctness there are two forms
// of these apis, internally they all use the non const ones
// but at least we don't have to force everyone to pass
// around non const json
bool getKey(TextView path, Value **ppValue,
            ValueType defaultValueType) noexcept;
bool getStr(TextView path, Text &str) noexcept(false);

// The const version of get key
const Value *getKey(TextView path) const noexcept {
    Value *val;
    if (!_constCast<Value *>(this)->getKey(path, &val, ValueType::nullValue))
        return nullptr;
    return val;
}

// The non const version of get key
Value *getKey(TextView path) noexcept {
    Value *val;
    if (!getKey(path, &val, ValueType::nullValue)) return nullptr;
    return val;
}

// The const version of get str
Opt<Text> getStr(TextView path) const noexcept(false) {
    Text str;
    if (!_constCast<Value *>(this)->getStr(path, str)) return NullOpt;
    return str;
}

void expandTree(const util::Vars &vars) noexcept(false);

// Conversion and lookup apis
private:
template <typename T, typename... Args>
ErrorOr<T> lookupInternal(TextView path, Args &&...args) const noexcept;

public:
// Clear the comments on this node and all its decendents
void clearComments() noexcept {
    // Remove comments from the current node
    if (comments_) {
        delete[] comments_;  // Free the allocated memory for the array
        comments_ =
            nullptr;  // Set the pointer to nullptr to avoid dangling references
    }
    // If the current node is an object, iterate through its members
    if (this->isObject()) {
        auto members = this->getMemberNames();
        for (const auto &key : members) {
            (*this)[key].clearComments();
        }
    }

    // If the current node is an array, iterate through its elements
    if (this->isArray()) {
        for (json::ArrayIndex i = 0; i < this->size(); ++i) {
            (*this)[i].clearComments();
        }
    }
}

// Until https://bugs.llvm.org/show_bug.cgi?id=23029 is resolved...
// we need to make a ton of wrappers as we cannot declare a
// defaulted argument before a parameter pack
//
// Versions with variable arguments
template <typename T = Value, typename... Args>
inline Error lookupAssign(TextView path, T &defaultTarget,
                          Args &&...args) const noexcept {
    if constexpr (traits::IsOptionalV<T>) {
        auto res = lookupInternal<traits::ValueT<T>>(
            path, std::forward<Args>(args)...);
        if (res.check()) {
            if (res.ccode() == Ec::NotFound) return {};
            return res.ccode();
        }
        defaultTarget.emplace(_mv(res.value()));
    } else {
        auto res = lookupInternal<T>(path, std::forward<Args>(args)...);
        if (res.check()) {
            if (res.ccode() == Ec::NotFound) return {};
            return res.ccode();
        }
        defaultTarget = _mv(res.value());
    }
    return {};
}

template <typename T = Value, typename... Args>
inline T lookup(TextView path, T defaultValue, Args &&...args) const noexcept {
    auto res = lookupInternal<T>(path, std::forward<Args>(args)...);
    if (res.check()) return _mv(defaultValue);
    return _mv(res.value());
}

template <typename T = Value, typename... Args>
inline ErrorOr<T> lookupCheck(TextView path, T defaultValue,
                              Args &&...args) const noexcept {
    auto res = lookupInternal<T>(path, std::forward<Args>(args)...);
    if (!res) {
        if (res.ccode() == Ec::NotFound) return _mv(defaultValue);
        return res.ccode();
    }
    return _mv(res.value());
}

// Versions without variable arguments
template <typename T = Value>
inline T lookup(TextView path, T defaultValue = {}) const noexcept {
    auto res = lookupInternal<T>(path);
    if (res.hasValue()) return _mv(res.value());
    return _mv(defaultValue);
}

template <typename T = Value>
inline ErrorOr<T> lookupCheck(TextView path,
                              T defaultValue = {}) const noexcept {
    auto res = lookupInternal<T>(path);
    if (res.check()) {
        if (res.ccode() == Ec::NotFound) return _mv(defaultValue);
        return res.ccode();
    }
    return _mv(res.value());
}

// Implicit boolean cast
explicit operator bool() const noexcept {
    return type() != ValueType::nullValue;
}

// Legacy forwards
auto text(TextView path, TextView defaultValue = {}) const noexcept {
    return lookup<Text>(path, defaultValue);
}
