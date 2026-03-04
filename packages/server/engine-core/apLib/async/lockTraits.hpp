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

namespace ap::async {

// Declare lock traits structure, when instantiated it will tell you
// everything you need to know about the lock type for your enable_if
// scopes in composed template classes
template <typename T>
struct LockTraits {
    using Type = T;
    using UniqueGuard = std::unique_lock<Type>;

    _const auto Owner =
        traits::IsDetectedExact<bool, traits::DetectOwnerIdMethod, Type>{};
    _const auto Count =
        traits::IsDetectedExact<bool, traits::DetectCountMethod, Type>{};
    _const auto Shared =
        traits::IsDetectedExact<bool, traits::DetectLockShared, Type>{};
    _const auto Timeout =
        traits::IsDetectedExact<bool, traits::DetectTryLockFor, Type>{};
    _const auto TryShared =
        traits::IsDetectedExact<bool, traits::DetectTryLockShared, Type>{};
    _const auto Try =
        traits::IsDetectedExact<bool, traits::DetectTryLock, Type>{};
};

}  // namespace ap::async
