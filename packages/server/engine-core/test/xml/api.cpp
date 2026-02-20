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

TEST_CASE("xml::api") {
    _const auto Expected =
        R"xml(<?xml version="1.0" encoding="UTF-8"?><Root><Node1>Value1<ChildNode1>Value11</ChildNode1></Node1><Node2>6<ChildNode2>Value22</ChildNode2></Node2><Node3>1GB</Node3></Root>)xml";

    SECTION("declare") {
        xml::Document doc;
        xml::declare(doc, R"(bobohi="HALLOW")");
        REQUIRE(xml::toString(doc, true) == R"(<?bobohi="HALLOW"?>)");
    }

    SECTION("addRender") {
        xml::Document doc;
        xml::declare(doc);
        auto root = xml::add(doc, "Root");
        auto n1 = xml::add(doc, root, "Node1", "Value1");
        auto n2 = xml::add(doc, root, "Node2", 6);
        xml::add(doc, n1, "ChildNode1", "Value11");
        xml::add(doc, n2, "ChildNode2", "Value22");
        xml::add(doc, root, "Node3", 1_gb);
        REQUIRE(xml::toString(doc, true) == Expected);
    }

    SECTION("parseFind") {
        xml::Document doc;
        *xml::parse(Expected, doc);
        REQUIRE(xml::toString(doc, true) == Expected);

        auto root = doc.RootElement();
        auto n1 = xml::findChild(root, "Node1");
        auto n2 = xml::findChild(root, "Node2");
        auto n3 = xml::findChild(root, "Node3");
        auto n11 = xml::findChild(n1, "ChildNode1");
        auto n22 = xml::findChild(n2, "ChildNode2");

        REQUIRE(xml::name(n1) == "Node1");
        REQUIRE(*xml::value(n1) == "Value1");

        REQUIRE(xml::name(n2) == "Node2");
        REQUIRE(*xml::value<int>(n2) == 6);

        REQUIRE(xml::name(n3) == "Node3");
        REQUIRE(*xml::value<Size>(n3) == 1_gb);

        REQUIRE(xml::name(n11) == "ChildNode1");
        REQUIRE(*xml::value(n11) == "Value11");

        REQUIRE(xml::name(n22) == "ChildNode2");
        REQUIRE(*xml::value(n22) == "Value22");
    }
}
