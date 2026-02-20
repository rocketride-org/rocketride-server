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

namespace ap::json {

template <typename T, typename... Args>
ErrorOr<T> fromJsonEx(const Value &j, Args &&...args) noexcept;

template <typename T, typename... Args>
ErrorOr<T> fromJsonEx(const Value *j, Args &&...args) noexcept;

template <typename T, typename... Args>
T fromJson(const Value &j, Args &&...args) noexcept;

template <typename T, typename... Args>
T fromJson(const Value *j, Args &&...args) noexcept;

template <typename T, typename... Args>
Error fromJsonAssign(const Value &j, T &res, Args &&...args) noexcept;

}  // namespace ap::json

// Aborts on error
#define _fj ::ap::json::fromJson

// Checked version, returns ErrorOr<Type>
#define _fjc ::ap::json::fromJsonEx

// Exception-aware version, returns Type but may throw
#define _fje *::ap::json::fromJsonEx

// Type-inferring version; type inferred from assignment target
#define _fja ::ap::json::fromJsonAssign
