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

namespace ap::json {

// Parse a json ext without constructing it first and optionally
// convert it to another type, it also bootstraps the vars subsystem
// and will expand all macros within the object tree
template <typename T, typename... Args>
inline ErrorOr<T> parse(TextView jsonString, Args&&... args) noexcept {
    json::Value j;
    if (auto ccode = j.parse(jsonString)) return ccode;

    // Bootstrap our var subsystem
    if (j.isObject()) {
        if (auto vars = j.lookup<util::Vars>("vars")) {
            j.expandTree(vars);
        }
    }

    LOG(Json, "Parsed\n{}", j);

    if constexpr (traits::IsSameTypeV<T, json::Value>)
        return j;
    else
        return _fjc<T>(j, std::forward<Args>(args)...);
}

}  // namespace ap::json
