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

namespace ap::xml {

// Alias some simple types from their explicit long form names
using Document = tinyxml2::XMLDocument;
using Declaration = tinyxml2::XMLDeclaration;
using Element = tinyxml2::XMLElement;
using Node = tinyxml2::XMLNode;
using Attribute = tinyxml2::XMLAttribute;
using Printer = tinyxml2::XMLPrinter;

// Callback based visitor allows for a lambda to get called
// for each element in a xml branch
template <typename Callback>
class CallbackVisitor : public tinyxml2::XMLVisitor {
public:
    CallbackVisitor(Callback&& cb) noexcept
        : m_cb(std::forward<Callback>(cb)) {}

    bool VisitExit(const Element& e) override { return m_cb(&e); }

private:
    Callback m_cb;
};

}  // namespace ap::xml
