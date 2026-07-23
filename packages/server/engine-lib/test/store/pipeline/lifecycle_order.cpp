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
// Unit tests for engine::store::computeLifecycleOrder.
//
// The function takes a pipeline's data connections and returns the order in
// which the source-reachable components should receive their lifecycle
// callbacks (open / closing / close).
//
// How to read these tests:
//   * `Conn` is a list of directed graph EDGES. Each edge is a tuple
//     {from, to, lane}: a data connection FROM node `from` TO node `to` on a
//     given lane. Node ids are small integers picked per test.
//   * `SRC` (== -1) is the pipeline SOURCE (the pipe head). An edge
//     {SRC, n, ...} means "the source feeds node n", i.e. n is an entry node.
//     Reachability is seeded from SRC, so every graph needs at least one SRC
//     edge; a node reachable from SRC via data edges is "source-reachable".
//   * The result is the source-reachable node ids in DEPENDENCY ORDER
//     (topological, upstream-first): every node appears AFTER all the nodes
//     that feed into it. Only the from/to wiring decides this; the lane
//     strings do not affect ordering (they only matter for collapsing
//     duplicate edges between the same pair).
//   * Different cases use different graphs, so their expected results differ
//     (a 3-node chain is {1,2,3}; a 2-node graph is {1,2}; an excluded node
//     drops out, etc.). Each SECTION draws its graph and the order it forces.
//-----------------------------------------------------------------------------
TEST_CASE("store::lifecycleOrder") {
    using Conn = std::vector<std::tuple<int, int, std::string>>;
    const int SRC = -1;  // the pipeline source / pipe head

    // Graph:  SRC -> 1 -> 2 -> 3   (a plain chain; the edges below are listed
    //                               back-to-front, as a badly-ordered .pipe
    //                               file would list them)
    // Order:  1, 2, 3              (dependency order ignores the listing order:
    //                               3 depends on 2 depends on 1)
    SECTION("chain in reverse declaration order") {
        Conn conns = {{2, 3, "text"}, {1, 2, "text"}, {SRC, 1, "tags"}};
        auto order = engine::store::computeLifecycleOrder(conns);
        REQUIRE_NO_ERROR(order);
        REQUIRE(*order == std::vector<int>{1, 2, 3});
    }

    // Graph:  SRC -> 1 --\
    //         SRC -> 2 ---> 3       (3 is a JOIN, fed by both 1 and 2)
    // Order:  1, 2, 3               (the join 3 must come after BOTH parents)
    SECTION("diamond join after both parents") {
        Conn conns = {
            {SRC, 1, "tags"}, {1, 3, "text"}, {SRC, 2, "tags"}, {2, 3, "text"}};
        auto order = engine::store::computeLifecycleOrder(conns);
        REQUIRE_NO_ERROR(order);
        REQUIRE(*order == std::vector<int>{1, 2, 3});
    }

    // Same diamond as above, but the 2->3 edge is listed BEFORE the 1->3 edge.
    // The join still lands after both parents; ties between 1 and 2 are broken
    // by first-seen order (1 appears first in the edge list), so 1 before 2.
    // Order:  1, 2, 3
    SECTION("join with late-declared parent edge") {
        Conn conns = {{SRC, 1, "tags"}, {SRC, 2, "tags"}, {2, 3, "text"},
                      {1, 3, "text"}};
        auto order = engine::store::computeLifecycleOrder(conns);
        REQUIRE_NO_ERROR(order);
        REQUIRE(*order == std::vector<int>{1, 2, 3});
    }

    // Graph:  SRC -> 1 -> 2
    //                 \-> 3         (1 fans out to two children)
    // Order:  1, 2, 3               (both children after their parent 1)
    SECTION("fan-out from interior node") {
        Conn conns = {{SRC, 1, "tags"}, {1, 2, "text"}, {1, 3, "text"}};
        auto order = engine::store::computeLifecycleOrder(conns);
        REQUIRE_NO_ERROR(order);
        REQUIRE(*order == std::vector<int>{1, 2, 3});
    }

    // Graph:  SRC -> 1
    //         SRC -> 2             (ONE source with two outgoing edges, i.e.
    //                               two entry nodes - not two sources; the
    //                               engine is single-source)
    // Order:  1, 2                 (both first-tier nodes, in first-seen order)
    SECTION("source fan-out") {
        Conn conns = {{SRC, 1, "tags"}, {SRC, 2, "tags"}};
        auto order = engine::store::computeLifecycleOrder(conns);
        REQUIRE_NO_ERROR(order);
        REQUIRE(*order == std::vector<int>{1, 2});
    }

    // Graph:  SRC -> 1              (1 is source-reachable)
    //         5   -> 4             (5 is invoke-only: never fed by the source,
    //                               so node 4 is reachable ONLY through 5)
    // Order:  1                    (4 and 5 are excluded - a control node drives
    //                               its own sub-pipeline, so it is not part of
    //                               the head's lifecycle walk; and no false
    //                               cycle is reported for the 5->4 edge)
    SECTION("control sub-pipeline node excluded") {
        Conn conns = {{SRC, 1, "tags"}, {5, 4, "text"}};
        auto order = engine::store::computeLifecycleOrder(conns);
        REQUIRE_NO_ERROR(order);
        REQUIRE(*order == std::vector<int>{1});
    }

    // Graph:  SRC -> 1 -> 4        (4 is reachable via 1 ...)
    //         5 ------> 4          (... and ALSO fed by control node 5)
    // Order:  1, 4                 (4 IS included because it is reachable via 1;
    //                               the 5->4 edge is ignored for ordering, so 4
    //                               is placed after its reachable parent 1)
    SECTION("mixed reachability node included after reachable parent") {
        Conn conns = {{SRC, 1, "tags"}, {1, 4, "text"}, {5, 4, "text"}};
        auto order = engine::store::computeLifecycleOrder(conns);
        REQUIRE_NO_ERROR(order);
        REQUIRE(*order == std::vector<int>{1, 4});
    }

    // Graph:  SRC -> 1 =(text)=> 2
    //                 =(json)=> 2   (two lanes between the SAME pair 1->2)
    // Order:  1, 2                  (the pair is a single dependency, so 2
    //                               appears exactly once)
    SECTION("multi-lane same-pair dedup") {
        Conn conns = {{SRC, 1, "tags"}, {1, 2, "text"}, {1, 2, "json"}};
        auto order = engine::store::computeLifecycleOrder(conns);
        REQUIRE_NO_ERROR(order);
        REQUIRE(*order == std::vector<int>{1, 2});
    }

    // The SAME diamond (SRC->1, SRC->2, 1->3, 2->3) listed two different ways.
    // Ties are broken by first-seen order, so whichever of the two roots is
    // listed first is emitted first: orderX lists 1 first -> {1,2,3}; orderY
    // lists 2 first -> {2,1,3}. Both are valid topological orders, and each is
    // pinned (the output never depends on hash-map iteration order).
    SECTION("deterministic first-seen tie-break") {
        Conn orderX = {
            {SRC, 1, "tags"}, {SRC, 2, "tags"}, {1, 3, "text"}, {2, 3, "text"}};
        Conn orderY = {
            {SRC, 2, "tags"}, {SRC, 1, "tags"}, {2, 3, "text"}, {1, 3, "text"}};

        auto rx = engine::store::computeLifecycleOrder(orderX);
        auto ry = engine::store::computeLifecycleOrder(orderY);
        REQUIRE_NO_ERROR(rx);
        REQUIRE_NO_ERROR(ry);
        REQUIRE(*rx == std::vector<int>{1, 2, 3});
        REQUIRE(*ry == std::vector<int>{2, 1, 3});

        // Same input twice -> identical output (no hash-order nondeterminism)
        auto rx2 = engine::store::computeLifecycleOrder(orderX);
        REQUIRE_NO_ERROR(rx2);
        REQUIRE(*rx2 == *rx);
    }

    // Graph:  SRC -> 1 -> 2 -> 1    (1 and 2 form a cycle, reachable from SRC)
    // Result: error                (a real cycle in the live pipeline)
    SECTION("cycle in reachable region errors") {
        Conn conns = {{SRC, 1, "tags"}, {1, 2, "text"}, {2, 1, "text"}};
        auto order = engine::store::computeLifecycleOrder(conns);
        REQUIRE_ERROR(order, Ec::InvalidParam, "Cycle detected");
    }

    // Graph:  SRC -> 1              (1 is reachable)
    //         2 -> 3 -> 2          (2 and 3 form a cycle, but SRC never reaches
    //                               them)
    // Order:  1, no error          (the unreachable cycle is out of scope, so
    //                               it is neither ordered nor rejected)
    SECTION("cycle in unreachable region ignored") {
        Conn conns = {{SRC, 1, "tags"}, {2, 3, "text"}, {3, 2, "text"}};
        auto order = engine::store::computeLifecycleOrder(conns);
        REQUIRE_NO_ERROR(order);
        REQUIRE(*order == std::vector<int>{1});
    }
}
