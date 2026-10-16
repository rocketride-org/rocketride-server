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

//-----------------------------------------------------------------------------
// resolveAnyLanes and validateLanesShape: the "*" (any) lane.
// `Conn` lists edges {from, to, lane}; SRC (-1) is the source. `declaring`
// stands in for the service definitions: node -> the lanes it produces.
//-----------------------------------------------------------------------------
TEST_CASE("store::anyLane") {
    using Conn = std::vector<std::tuple<int, int, std::string>>;
    using engine::store::LaneDeclaration;
    using Declared = std::map<int, LaneDeclaration>;
    const int SRC = -1;

    auto declaring = [](Declared table) {
        return [table](int node) -> ErrorOr<LaneDeclaration> {
            auto it = table.find(node);
            if (it == table.end()) return LaneDeclaration{};
            return it->second;
        };
    };
    const LaneDeclaration SINK{{}, true};
    const std::vector<std::string> PARSE = {"text", "table", "image", "video",
                                            "audio"};

    // Graph:  SRC -(tags)-> parse(0) -(*)-> gate(1) -(text)-> response(2)
    //                                              \-(table)-> store(3)
    // Result: the star becomes text and table only; parse never sees image,
    //         video or audio listened to, exactly as with two typed wires.
    SECTION("star binds the lanes the consumers ask for") {
        Conn conns = {{SRC, 0, "tags"}, {0, 1, "*"}, {1, 2, "text"}, {1, 3, "table"}};
        auto resolved = engine::store::resolveAnyLanes(conns, declaring({{0, {PARSE}}}));
        REQUIRE_NO_ERROR(resolved);
        REQUIRE(*resolved == Conn{{SRC, 0, "tags"}, {0, 1, "text"}, {0, 1, "table"},
                                  {1, 2, "text"}, {1, 3, "table"}});
    }

    // Graph:  SRC -(tags)-> parse(0) -(*)-> gate(1) -(*)-> gate(2) -(documents)-> store(3)
    // Result: both stars resolve to documents, and nothing else, because the
    //         only consumer asks for documents (parse declares none; the
    //         declaration here says it does, to isolate the chaining).
    SECTION("chained stars resolve to the lane at the end") {
        Conn conns = {{SRC, 0, "tags"}, {0, 1, "*"}, {1, 2, "*"}, {2, 3, "documents"}};
        auto resolved = engine::store::resolveAnyLanes(
            conns, declaring({{0, {{"text", "documents"}}}}));
        REQUIRE_NO_ERROR(resolved);
        REQUIRE(*resolved == Conn{{SRC, 0, "tags"}, {0, 1, "documents"},
                                  {1, 2, "documents"}, {2, 3, "documents"}});
    }

    // Graph:  parse(0) -(*)-> gate(2) -(text)-> response(3)
    //         ocr(1)   -(*)-/            \-(table)-> store(4)
    // Result: each source is bound only on the lanes IT produces: parse on
    //         text and table, ocr (declares table) on table alone.
    SECTION("two sources are each bound on what they produce") {
        Conn conns = {{SRC, 0, "tags"}, {SRC, 1, "tags"}, {0, 2, "*"}, {1, 2, "*"},
                      {2, 3, "text"}, {2, 4, "table"}};
        auto resolved = engine::store::resolveAnyLanes(
            conns, declaring({{0, {PARSE}}, {1, {{"table"}}}}));
        REQUIRE_NO_ERROR(resolved);
        REQUIRE(*resolved == Conn{{SRC, 0, "tags"}, {SRC, 1, "tags"}, {0, 2, "text"},
                                  {0, 2, "table"}, {1, 2, "table"}, {2, 3, "text"},
                                  {2, 4, "table"}});
    }

    // Graph:  parse(0) -(text)-> passthrough(1) -(*)-> gate(2) -(text)-> response(3)
    // Result: node 1 declares nothing (a pass-through, as the services.json
    //         rules say), but text is wired into it, so it can produce text.
    SECTION("a pass-through node produces what is wired into it") {
        Conn conns = {{SRC, 0, "tags"}, {0, 1, "text"}, {1, 2, "*"}, {2, 3, "text"}};
        auto resolved = engine::store::resolveAnyLanes(conns, declaring({{0, {PARSE}}}));
        REQUIRE_NO_ERROR(resolved);
        REQUIRE(*resolved == Conn{{SRC, 0, "tags"}, {0, 1, "text"}, {1, 2, "text"},
                                  {2, 3, "text"}});
    }

    // Graph:  SRC -(*)-> gate(1) -(questions)-> llm(2)
    //         the source itself (chat, declaring questions) feeds the star
    // Result: the star becomes questions from the source.
    SECTION("a star straight from the source") {
        Conn conns = {{SRC, 1, "*"}, {1, 2, "questions"}};
        auto resolved = engine::store::resolveAnyLanes(
            conns, declaring({{SRC, {{"questions"}}}}));
        REQUIRE_NO_ERROR(resolved);
        REQUIRE(*resolved == Conn{{SRC, 1, "questions"}, {1, 2, "questions"}});
    }

    // Graph:  SRC -(tags)-> parse(0) -(*)-> sink(1)      (nothing after the sink)
    //         the sink declares {"*": []}: takes any lane, forwards nothing
    // Result: with no consumer to ask, the sink is bound on everything parse
    //         produces, in the engine's lane order.
    SECTION("an any-lane sink takes everything its source produces") {
        Conn conns = {{SRC, 0, "tags"}, {0, 1, "*"}};
        auto resolved = engine::store::resolveAnyLanes(
            conns, declaring({{0, {PARSE}}, {1, SINK}}));
        REQUIRE_NO_ERROR(resolved);
        REQUIRE(*resolved == Conn{{SRC, 0, "tags"}, {0, 1, "text"}, {0, 1, "table"},
                                  {0, 1, "audio"}, {0, 1, "video"}, {0, 1, "image"}});
    }

    // No star anywhere: the table comes back as it went in, same order.
    SECTION("typed connections are untouched") {
        Conn conns = {{1, 2, "text"}, {SRC, 1, "tags"}, {1, 3, "json"}};
        auto resolved = engine::store::resolveAnyLanes(conns, declaring({}));
        REQUIRE_NO_ERROR(resolved);
        REQUIRE(*resolved == conns);
    }

    // Graph:  parse(0) -(*)-> gate(1)        (nothing after the gate)
    // Result: refused, naming the node: it would silently receive nothing.
    SECTION("a star node with no consumer is refused") {
        Conn conns = {{SRC, 0, "tags"}, {0, 1, "*"}};
        auto resolved = engine::store::resolveAnyLanes(
            conns, declaring({{0, {PARSE}}}), {"\"Parse\" (parse_1)", "\"Gate\" (gate_1)"});
        REQUIRE_ERROR(resolved, Ec::InvalidParam,
                      "Component \"Gate\" (gate_1) accepts any lane but nothing is "
                      "wired after it");
    }

    // Graph:  textonly(0) -(*)-> gate(1) -(image)-> vision(2)
    // Result: refused, naming the lane and the node: nothing before the gate
    //         produces image.
    SECTION("a lane nothing upstream produces is refused") {
        Conn conns = {{SRC, 0, "tags"}, {0, 1, "*"}, {1, 2, "image"}};
        auto resolved = engine::store::resolveAnyLanes(
            conns, declaring({{0, {{"text"}}}}), {"\"Text\" (text_1)", "\"Gate\" (gate_1)"});
        REQUIRE_ERROR(resolved, Ec::InvalidParam,
                      "Component \"Gate\" (gate_1) is asked for image by what "
                      "follows it, but nothing wired into it produces image");
    }

    // Graph:  chat(0) -(*)-> gate(1) -(text)-> response(2)
    //         chat declares questions; the gate declares text as its own (the
    //         nine-lane Gate does), so the node-level check is satisfied, yet
    //         the star edge from chat stands for no lane at all.
    // Result: refused, naming both ends, instead of a gate that is never fed.
    SECTION("a star edge that stands for no lane is refused") {
        Conn conns = {{SRC, 0, "tags"}, {0, 1, "*"}, {1, 2, "text"}};
        auto resolved = engine::store::resolveAnyLanes(
            conns, declaring({{0, {{"questions"}}}, {1, {{"text"}}}}),
            {"\"Chat\" (chat_1)", "\"Gate\" (gate_1)"});
        REQUIRE_ERROR(resolved, Ec::InvalidParam,
                      "Component \"Gate\" (gate_1) takes any lane from \"Chat\" "
                      "(chat_1) but \"Chat\" (chat_1) produces none of the lanes "
                      "asked of it");
    }

    // A node whose definition cannot be found: the error comes back as is,
    // never a silent skip.
    SECTION("a missing definition is an error, not a skip") {
        Conn conns = {{SRC, 0, "tags"}, {0, 1, "*"}, {1, 2, "text"}};
        auto missing = [](int node) -> ErrorOr<LaneDeclaration> {
            if (node == 0) return APERR(Ec::InvalidParam, "no definition for node 0");
            return LaneDeclaration{};
        };
        auto resolved = engine::store::resolveAnyLanes(conns, missing);
        REQUIRE_ERROR(resolved, Ec::InvalidParam, "no definition for node 0");
    }

    // Graph:  a(1) -(*)-> b(2) -(*)-> a(1)   (stars in a loop)
    // Result: refused instead of recursing forever.
    SECTION("a cycle of stars is refused") {
        Conn conns = {{SRC, 1, "tags"}, {1, 2, "*"}, {2, 1, "*"}, {2, 3, "text"}};
        auto resolved = engine::store::resolveAnyLanes(conns, declaring({}));
        REQUIRE_ERROR(resolved, Ec::InvalidParam, "Cycle through \"*\" connections");
    }
}

TEST_CASE("store::validateLanesShape") {
    using engine::store::IServices;

    SECTION("the any-lane shape is accepted") {
        json::Value lanes;
        REQUIRE_NO_ERROR(lanes.parse(R"({"*": ["*"]})"));
        REQUIRE_NO_ERROR(IServices::validateLanesShape(lanes, "gate"));
    }

    SECTION("any lane in, named lanes out is accepted") {
        json::Value lanes;
        REQUIRE_NO_ERROR(lanes.parse(R"({"*": ["text"]})"));
        REQUIRE_NO_ERROR(IServices::validateLanesShape(lanes, "gate"));
    }

    SECTION("typed lanes are untouched") {
        json::Value lanes;
        REQUIRE_NO_ERROR(lanes.parse(R"({"tags": ["text", "table"]})"));
        REQUIRE_NO_ERROR(IServices::validateLanesShape(lanes, "parse"));
    }

    SECTION("a star beside a named lane is refused") {
        json::Value lanes;
        REQUIRE_NO_ERROR(lanes.parse(R"({"*": ["*"], "answers": ["text"]})"));
        REQUIRE_ERROR(IServices::validateLanesShape(lanes, "gate"), Ec::InvalidParam,
                      "Service gate declares the \"*\" lane beside the named lane "
                      "answers");
    }

    SECTION("a star whose outputs are not a list is refused") {
        json::Value lanes;
        REQUIRE_NO_ERROR(lanes.parse(R"({"*": "text"})"));
        REQUIRE_ERROR(IServices::validateLanesShape(lanes, "gate"), Ec::InvalidParam,
                      "Service gate lanes[\"*\"] must be a list of lanes");
    }

    SECTION("a star mixed with named outputs is refused") {
        json::Value lanes;
        REQUIRE_NO_ERROR(lanes.parse(R"({"*": ["*", "text"]})"));
        REQUIRE_ERROR(IServices::validateLanesShape(lanes, "gate"), Ec::InvalidParam,
                      "Service gate lists \"*\" beside named lanes");
    }
}
