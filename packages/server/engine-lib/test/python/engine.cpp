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

#include <pybind11/embed.h>

#include "test.h"

namespace py = pybind11;

TEST_CASE("python::config") {
    auto rootDir = application::execDir();
    auto extensionDir = application::projectDir() ? application::projectDir() / "extension" : "";
    auto packagesDir = application::projectDir() ? application::projectDir() / "packages" : "";
    auto nodesDir = application::projectDir() ? application::projectDir() / "nodes" : "";

    const auto python = localfcn()->Error {
        py::module_ sys = py::module_::import("sys");
        REQUIRE(rootDir == file::Path(sys.attr("prefix").cast<std::string>()));
        REQUIRE(rootDir == file::Path(sys.attr("exec_prefix").cast<std::string>()));
        REQUIRE(rootDir.isParentOf(file::Path(sys.attr("executable").cast<std::string>())));
        REQUIRE(rootDir == file::Path(sys.attr("base_prefix").cast<std::string>()));
        REQUIRE(rootDir == file::Path(sys.attr("base_exec_prefix").cast<std::string>()));
        REQUIRE(rootDir.isParentOf(file::Path(sys.attr("_base_executable").cast<std::string>())));
        return {};
    };

    REQUIRE_NO_ERROR(callPython(python));
}

TEST_CASE("python::webhook") {
    REQUIRE_NO_ERROR(engine::python::loadModule("nodes.webhook", true));
}
