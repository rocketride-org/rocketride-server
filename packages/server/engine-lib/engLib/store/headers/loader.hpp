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

namespace engine::store {
namespace py = pybind11;

//
// This class defines the main endpoint for loading. This
// essentially creates a target endpont to write to.
//
class ILoader {
public:
    // Default constructor, really doesn't do anything
    ILoader() {}
    ~ILoader() { target = {}; }

    // Begin load establishes the endpoint
    void beginLoad(const py::dict &pipes);

    // Destroy the endpoint
    void endLoad();

    // Static function to get the pipe stack from the pipe specifications
    static py::dict getPipeStack(const py::dict &pipes);

    // Current endpoint that provides a pipes for loading data.
    ServiceEndpoint target{};
};
}  // namespace engine::store
