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

#include "test.h"

namespace engine::python::test {
const ::PyConfig &config() noexcept;
}  // namespace engine::python::test

TEST_CASE("python::config") {
    // Get initialized python config
    const auto &config = python::test::config();

    // Check each of the python config paths is either the root or the nested
    // path
    auto rootDir = application::execDir();
    REQUIRE(rootDir == file::Path(config.home));
    REQUIRE(rootDir == file::Path(config.base_exec_prefix));
    REQUIRE(rootDir.isParentOf(file::Path(config.base_executable)));
    REQUIRE(rootDir == file::Path(config.base_prefix));
    REQUIRE(rootDir == file::Path(config.exec_prefix));
    REQUIRE(rootDir.isParentOf(file::Path(config.executable)));
    for (::Py_ssize_t i = 0; i < config.module_search_paths.length; ++i)
        REQUIRE(rootDir.isParentOf(
            file::Path(config.module_search_paths.items[i])));
    REQUIRE(rootDir == file::Path(config.prefix));
}

TEST_CASE("python::webhook") {
    REQUIRE_NO_ERROR(engine::python::loadModule("nodes.webhook", true));
}
