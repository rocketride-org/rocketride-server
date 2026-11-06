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

namespace engine::store {
//-------------------------------------------------------------------------
//
//	A node's stored config is path-addressed: a leaf inside a selector
//	branch lives nested ({"cloud": {"apikey": ...}}) and the service
//	definition registers it under its dotted path ("cloud.apikey", see
//	IServices::ServiceDefinition::secureParameters). These helpers walk
//	such a key as a nested path into a parameters object; a root leaf is
//	the one-segment case. They are deliberately side-effect free on
//	lookup - unlike json::Value::getKey(), they never create members
//	while walking.
//
//-------------------------------------------------------------------------

//-------------------------------------------------------------------------
/// @details
///		Finds the leaf at a dotted path
///	@param[in] root
///		The parameters object to walk
///	@param[in] key
///		The dotted path of the leaf
///	@return
///		The leaf, or nullptr when it or any intermediate is absent
//-------------------------------------------------------------------------
inline const json::Value *findNested(const json::Value &root,
                                     TextView key) noexcept {
    // An empty key names nothing - never the whole object
    if (key.empty()) return nullptr;

    const auto *node = &root;
    for (const auto &segment : string::split(key, ".")) {
        if (!node->isObject() || !node->isMember(segment)) return nullptr;
        node = &(*node)[segment];
    }
    return node;
}

//-------------------------------------------------------------------------
/// @details
///		Sets the leaf at a dotted path, creating the intermediate objects
///	@param[in,out] root
///		The parameters object to write into
///	@param[in] key
///		The dotted path of the leaf
///	@param[in] value
///		The value to store
//-------------------------------------------------------------------------
inline void setNested(json::Value &root, TextView key,
                      const json::Value &value) noexcept {
    // An empty key names nothing
    if (key.empty()) return;

    auto *node = &root;
    const auto segments = string::split(key, ".");
    if (segments.empty()) return;
    for (size_t index = 0; index + 1 < segments.size(); ++index) {
        auto &next = (*node)[segments[index]];
        if (!next.isObject()) next = json::Value(json::objectValue);
        node = &next;
    }
    (*node)[segments.back()] = value;
}

//-------------------------------------------------------------------------
/// @details
///		Removes the leaf at a dotted path; a missing intermediate means
///		there is nothing to remove
///	@param[in,out] root
///		The parameters object to remove from
///	@param[in] key
///		The dotted path of the leaf
//-------------------------------------------------------------------------
inline void removeNested(json::Value &root, TextView key) noexcept {
    // An empty key names nothing
    if (key.empty()) return;

    auto *node = &root;
    const auto segments = string::split(key, ".");
    if (segments.empty()) return;
    for (size_t index = 0; index + 1 < segments.size(); ++index) {
        if (!node->isObject() || !node->isMember(segments[index])) return;
        node = &(*node)[segments[index]];
    }
    if (node->isObject()) node->removeMember(segments.back());
}

}  // namespace engine::store
