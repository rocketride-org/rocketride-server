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

#include "test.h"

TEST_CASE("perms::rights") {
    using namespace engine::perms;

    std::pair<int, Text> p{4, "3"};
    std::pair<int, Text> p2{5, "2"};

    // Build a sorted set of all string representations of rights
    std::set<Text> rightStrings = {"", "+r", "+w", "+r", "+w", "+rw"};

    // Build a sorted set of all possible right objects
    std::set<Rights> rights;
    for (auto& string : rightStrings) {
        rights.insert(_fs<Rights>(string));
    }

    // Verify they were all inserted
    REQUIRE(rights.size() == rightStrings.size());
}

TEST_CASE("perms::permissionSet") {
    using namespace engine::perms;

    // Just owners
    _using(PermissionSetBuilder psb) {
        psb.add("A", {});
        REQUIRE(psb.size() == 1);

        psb.add("A", {});
        REQUIRE(psb.size() == 1);

        psb.add("B", {});
        REQUIRE(psb.size() == 2);
    }

    // No owners
    _using(PermissionSetBuilder psb) {
        psb.add("", {{"A", _fs<Rights>("+rw")}});
        REQUIRE(psb.size() == 1);

        psb.add("", {{"A", _fs<Rights>("+rw")}});
        REQUIRE(psb.size() == 1);
    }

    // Simple test
    _using(PermissionSetBuilder psb) {
        psb.add("A", {{"A", _fs<Rights>("+rw")}});
        REQUIRE(psb.size() == 1);

        psb.add("A", {{"A", _fs<Rights>("+rw")}});
        REQUIRE(psb.size() == 1);
    }

    // Permission ordering
    _using(PermissionSetBuilder psb) {
        psb.add("A", {{"A", _fs<Rights>("+rw")}});
        REQUIRE(psb.size() == 1);

        psb.add("A", {{"A", _fs<Rights>("+rw")}, {"B", _fs<Rights>("+rw")}});
        REQUIRE(psb.size() == 2);

        psb.add("A", {{"B", _fs<Rights>("+rw")}, {"A", _fs<Rights>("+rw")}});
        REQUIRE(psb.size() == 2);
    }

    // Duplicate permissions
    _using(PermissionSetBuilder psb) {
        psb.add("A", {{"A", _fs<Rights>("+rw")},
                      {"A", _fs<Rights>("+rw")},
                      {"A", _fs<Rights>("+rw")}});
        auto psl = psb.build();
        REQUIRE(psl.size() == 1);
        auto& ps = *psl.begin();
        REQUIRE(ps.perms.size() == 1);
    }
}
