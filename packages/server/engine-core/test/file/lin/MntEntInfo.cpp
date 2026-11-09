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

using namespace ap;
using namespace ap::file;

TEST_CASE("file::MntEntInfo") {
    REQUIRE(!isOnRemovableDrive("/"));
    if (exists("/Volumes/UNTITLED")) {
        REQUIRE(isOnRemovableDrive("/Volumes/UNTITLED"));
    }
}

/// The mount cache is read from the first mount table that can be opened.
/// A missing table, such as /etc/mtab in some minimal containers, must not
/// leave the cache empty when a later table can be read.
TEST_CASE("file::refreshMounting falls back to the next mount table") {
    // With only a missing table there is nothing to read
    REQUIRE(refreshMounting({"/nonexistent/mtab"})->mapping.empty());

    // A missing table followed by the kernel's own fills the cache from it
    auto cache = refreshMounting({"/nonexistent/mtab", "/proc/self/mounts"});
    struct stat root{};
    REQUIRE(::stat("/", &root) == 0);
    REQUIRE(cache->mapping.count(root.st_dev) == 1);
    REQUIRE(std::any_of(cache->items.begin(), cache->items.end(),
                        [](const MntEntInfo &info) {
                            return std::find(info.types.begin(),
                                             info.types.end(),
                                             FsType::Proc) != info.types.end();
                        }));
}
