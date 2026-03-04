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

namespace ap {

// Creates a basic parent child relationship between two classes
template <typename ParentT>
class ChildOf {
public:
    // Declare our instantiated type
    using ParentType = std::remove_reference_t<ParentT>;

    // Construct from a parent reference
    ChildOf(ParentType &parent) noexcept : m_parent(parent) {}

    // Declare default move/copy constructors and operators
    // this is ok since we use a Ref (std::reference_wrapper) to
    // hold the reference to the parent
    ChildOf(const ChildOf &child) = default;
    ChildOf(ChildOf &&child) = default;
    ChildOf &operator=(const ChildOf &child) = default;
    ChildOf &operator=(ChildOf &&child) = default;

protected:
    // Parent accessor
    decltype(auto) parent() noexcept { return m_parent.get(); }

    // Const parent accessor
    decltype(auto) parent() const noexcept { return m_parent.get(); }

    // Reference to parent
    Ref<ParentType> m_parent;
};

}  // namespace ap
