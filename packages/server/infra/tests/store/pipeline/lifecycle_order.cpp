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

    //-------------------------------------------------------------------------
    // Per-root regions. A control node (an invoked node, id 7/8 below) is a
    // lifecycle root that drives the sub-pipeline it reaches, exactly as the
    // source (-1) drives its region. `barriers` are the OTHER control roots
    // (joined as a member when reached, but not expanded past); `claimed` are
    // nodes an earlier region already owns (excluded). The single-arg default
    // form used above is root=-1 with no barriers/claimed - the source region.
    //-------------------------------------------------------------------------

    // Graph:  7 -> 1 --\
    //         7 -> 2 ---> 3     (control node 7 drives a diamond; 3 is the join)
    // Region 7:  1, 2, 3        (the join lands after BOTH branches - the bug
    //                            this whole change fixes, one level down)
    // Head:      {}             (nothing is source-reachable)
    SECTION("control-root diamond ordered as its own region") {
        Conn conns = {{7, 1, "text"}, {7, 2, "text"}, {1, 3, "text"},
                      {2, 3, "text"}};
        auto region = engine::store::computeLifecycleOrder(conns, 7);
        REQUIRE_NO_ERROR(region);
        REQUIRE(*region == std::vector<int>{1, 2, 3});

        auto head = engine::store::computeLifecycleOrder(conns, SRC, {7});
        REQUIRE_NO_ERROR(head);
        REQUIRE(head->empty());
    }

    // Graph:  SRC -> 1 -> 2        (the source region)
    //         7   -> 3 -> 4       (control node 7's region, disjoint)
    // Head:      1, 2
    // Region 7:  3, 4              (computed with the head's nodes claimed)
    SECTION("source and control regions partition") {
        Conn conns = {{SRC, 1, "tags"}, {1, 2, "text"}, {7, 3, "text"},
                      {3, 4, "text"}};
        auto head = engine::store::computeLifecycleOrder(conns, SRC, {7});
        REQUIRE_NO_ERROR(head);
        REQUIRE(*head == std::vector<int>{1, 2});

        auto region = engine::store::computeLifecycleOrder(conns, 7, {7}, {1, 2});
        REQUIRE_NO_ERROR(region);
        REQUIRE(*region == std::vector<int>{3, 4});
    }

    // Graph:  SRC -> 1            (1 is source-reachable -> head-owned)
    //         7   -> 1           (7 ALSO feeds 1, but the head claimed it first)
    //         7   -> 2
    // Head:      1                (mixed-boundary node stays head-owned)
    // Region 7:  2                (1 is claimed, so excluded from 7's region)
    // NOTE: computeLifecycleRegions REJECTS this shape (control root 7 data-reaches
    // head-owned node 1) - see store::lifecycleRegions. This pins the primitive's
    // per-region math only.
    SECTION("mixed boundary node is head-owned and excluded from control region") {
        Conn conns = {{SRC, 1, "tags"}, {7, 1, "text"}, {7, 2, "text"}};
        auto head = engine::store::computeLifecycleOrder(conns, SRC, {7});
        REQUIRE_NO_ERROR(head);
        REQUIRE(*head == std::vector<int>{1});

        auto region = engine::store::computeLifecycleOrder(conns, 7, {7}, {1});
        REQUIRE_NO_ERROR(region);
        REQUIRE(*region == std::vector<int>{2});
    }

    // Graph:  SRC -> 1 -> 7 -> 2   (control node 7 is itself DATA-fed from the
    //                               source, then drives its own child 2)
    // Head:      1, 7              (7 joins the head region as a boundary member,
    //                               ordered after its parent 1, but NOT expanded)
    // Region 7:  2                 (7's own child, with 1 and 7 claimed)
    // NOTE: computeLifecycleRegions REJECTS this whole shape (a data-fed control
    // root that owns a sub-pipeline is double-driven) - see store::lifecycleRegions.
    // This section only pins the primitive's per-region math.
    SECTION("data-fed control root joins its owner region as a boundary") {
        Conn conns = {{SRC, 1, "tags"}, {1, 7, "text"}, {7, 2, "text"}};
        auto head = engine::store::computeLifecycleOrder(conns, SRC, {7});
        REQUIRE_NO_ERROR(head);
        REQUIRE(*head == std::vector<int>{1, 7});

        auto region = engine::store::computeLifecycleOrder(conns, 7, {7}, {1, 7});
        REQUIRE_NO_ERROR(region);
        REQUIRE(*region == std::vector<int>{2});
    }

    // Graph:  7 -> 1 -> 8 -> 2     (control node 7's region contains inner
    //                               control node 8; 8 drives its own child 2)
    // Region 7:  1, 8              (stops AT 8 - it is ordered but not expanded)
    // Region 8:  2                 (the inner region)
    // NOTE: computeLifecycleRegions REJECTS this shape too (8 is data-fed by 7 and
    // owns a sub-pipeline) - see store::lifecycleRegions. Control-only nesting (no
    // data edge between the roots) is allowed; this pins the primitive's math.
    SECTION("nested control roots: outer region stops at the inner root") {
        Conn conns = {{7, 1, "text"}, {1, 8, "text"}, {8, 2, "text"}};
        auto outer = engine::store::computeLifecycleOrder(conns, 7, {7, 8});
        REQUIRE_NO_ERROR(outer);
        REQUIRE(*outer == std::vector<int>{1, 8});

        auto inner = engine::store::computeLifecycleOrder(conns, 8, {7, 8});
        REQUIRE_NO_ERROR(inner);
        REQUIRE(*inner == std::vector<int>{2});
    }

    // Graph:  7 -> 1
    //         8 -> 2              (two independent control roots)
    // Region 7:  1
    // Region 8:  2
    SECTION("detached inner root keeps its own region") {
        Conn conns = {{7, 1, "text"}, {8, 2, "text"}};
        auto r7 = engine::store::computeLifecycleOrder(conns, 7, {7, 8});
        REQUIRE_NO_ERROR(r7);
        REQUIRE(*r7 == std::vector<int>{1});

        auto r8 = engine::store::computeLifecycleOrder(conns, 8, {7, 8});
        REQUIRE_NO_ERROR(r8);
        REQUIRE(*r8 == std::vector<int>{2});
    }

    // Graph:  SRC -> 1            (control node 7 has NO data children)
    // Region 7:  {}               (empty - the engine drives nothing for it)
    SECTION("root with no data children yields an empty region") {
        Conn conns = {{SRC, 1, "tags"}};
        auto region = engine::store::computeLifecycleOrder(conns, 7, {7});
        REQUIRE_NO_ERROR(region);
        REQUIRE(region->empty());
    }

    // Graph:  7 -> 1 -> 2 -> 1     (1 and 2 form a cycle inside 7's region)
    // Result: error                (a real cycle in a live sub-pipeline)
    SECTION("cycle inside a control region errors") {
        Conn conns = {{7, 1, "text"}, {1, 2, "text"}, {2, 1, "text"}};
        auto region = engine::store::computeLifecycleOrder(conns, 7);
        REQUIRE_ERROR(region, Ec::InvalidParam, "Cycle detected");
    }

    // Graph:  7 -> 1              (1 is in 7's region)
    //         2 -> 3 -> 2        (a cycle 7 never reaches)
    // Region 7:  1, no error      (the cycle is outside the region, so ignored)
    SECTION("cycle outside the requested region ignored") {
        Conn conns = {{7, 1, "text"}, {2, 3, "text"}, {3, 2, "text"}};
        auto region = engine::store::computeLifecycleOrder(conns, 7);
        REQUIRE_NO_ERROR(region);
        REQUIRE(*region == std::vector<int>{1});
    }

    // Graph:  7 -> 1 --\
    //         8 -> 1 ---> 2       (node 1 is reached by BOTH control roots)
    // Both regions compute {1,2} here at the primitive level; the ambiguous
    // ownership is REJECTED in buildConnections (which sees both regions claim
    // node 1). This section pins the overlap the driver's rejection keys off.
    SECTION("overlapping control regions are both computed") {
        Conn conns = {{7, 1, "text"}, {8, 1, "text"}, {1, 2, "text"}};
        auto r7 = engine::store::computeLifecycleOrder(conns, 7, {7, 8});
        REQUIRE_NO_ERROR(r7);
        REQUIRE(*r7 == std::vector<int>{1, 2});

        auto r8 = engine::store::computeLifecycleOrder(conns, 8, {7, 8});
        REQUIRE_NO_ERROR(r8);
        REQUIRE(*r8 == std::vector<int>{1, 2});
    }

    // The SAME control-root diamond listed two ways. As with the source region,
    // ties break by first-seen order: orderX lists 1 first -> {1,2,3}; orderY
    // lists 2 first -> {2,1,3}. Each is pinned (no hash-order nondeterminism).
    SECTION("deterministic tie-break within a control region") {
        Conn orderX = {{7, 1, "text"}, {7, 2, "text"}, {1, 3, "text"},
                       {2, 3, "text"}};
        Conn orderY = {{7, 2, "text"}, {7, 1, "text"}, {2, 3, "text"},
                       {1, 3, "text"}};

        auto rx = engine::store::computeLifecycleOrder(orderX, 7);
        auto ry = engine::store::computeLifecycleOrder(orderY, 7);
        REQUIRE_NO_ERROR(rx);
        REQUIRE_NO_ERROR(ry);
        REQUIRE(*rx == std::vector<int>{1, 2, 3});
        REQUIRE(*ry == std::vector<int>{2, 1, 3});

        auto rx2 = engine::store::computeLifecycleOrder(orderX, 7);
        REQUIRE_NO_ERROR(rx2);
        REQUIRE(*rx2 == *rx);
    }
}

//-----------------------------------------------------------------------------
// Unit tests for engine::store::computeLifecycleRegions - the full partition
// (head region + one region per invoked node) and its ownership rules. Same
// Conn/SRC conventions as above; `invoked` is the list of controls-table
// targets (the invoked node indices).
//-----------------------------------------------------------------------------
TEST_CASE("store::lifecycleRegions") {
    using Conn = std::vector<std::tuple<int, int, std::string>>;
    const int SRC = -1;

    // Graph:  SRC -> 1        (the head region)
    //         7   -> 2 -> 3   (control node 7's region, disjoint)
    SECTION("source and control regions partition") {
        Conn conns = {{SRC, 1, "tags"}, {7, 2, "text"}, {2, 3, "text"}};
        std::vector<int> invoked = {7};
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_NO_ERROR(regions);
        REQUIRE(regions->head == std::vector<int>{1});
        REQUIRE(regions->control.size() == 1);
        REQUIRE(regions->control[0].first == 7);
        REQUIRE(regions->control[0].second == std::vector<int>{2, 3});
    }

    // A node reached by two control roots has no single owner -> rejected.
    SECTION("reject node reachable from two control roots") {
        Conn conns = {{7, 1, "text"}, {8, 1, "text"}, {1, 2, "text"}};
        std::vector<int> invoked = {7, 8};
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_ERROR(regions, Ec::InvalidParam, "reachable from two control roots");
    }

    // Node 7 is invoked AND data-fed (SRC -> 1 -> 7) AND owns a sub-pipeline
    // (7 -> 2). Its owning region would double-drive that sub-pipeline, so it
    // is rejected.
    SECTION("reject data-fed control root that owns a sub-pipeline") {
        Conn conns = {{SRC, 1, "tags"}, {1, 7, "text"}, {7, 2, "text"}};
        std::vector<int> invoked = {7};
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_ERROR(regions, Ec::InvalidParam,
                      "drives a sub-pipeline and is also data-fed");
    }

    // Node 7 is invoked AND data-fed but has NO sub-pipeline (no outgoing data
    // edge) -> allowed: nothing to double-drive, the head just drives 7 once.
    SECTION("allow data-fed invoked node with no sub-pipeline") {
        Conn conns = {{SRC, 1, "tags"}, {1, 7, "text"}};
        std::vector<int> invoked = {7};
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_NO_ERROR(regions);
        REQUIRE(regions->head == std::vector<int>{1, 7});
        REQUIRE(regions->control.empty());
    }

    // Nested via data: 7 -> 1 -> 8 -> 2, with 8 invoked. 8 is data-fed (by 1)
    // AND owns a sub-pipeline (8 -> 2) -> rejected, same as the head case.
    SECTION("reject nested control root data-fed by another") {
        Conn conns = {{7, 1, "text"}, {1, 8, "text"}, {8, 2, "text"}};
        std::vector<int> invoked = {7, 8};
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_ERROR(regions, Ec::InvalidParam,
                      "drives a sub-pipeline and is also data-fed");
    }

    // Two invoked nodes with independent sub-pipelines and no data edge between
    // them (control-only nesting) -> allowed, each owns its own region.
    SECTION("allow independent control roots (no data edge between them)") {
        Conn conns = {{7, 1, "text"}, {8, 2, "text"}};
        std::vector<int> invoked = {7, 8};
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_NO_ERROR(regions);
        REQUIRE(regions->head.empty());
        REQUIRE(regions->control.size() == 2);
        REQUIRE(regions->control[0] == std::pair<int, std::vector<int>>{7, {1}});
        REQUIRE(regions->control[1] == std::pair<int, std::vector<int>>{8, {2}});
    }

    // A node invoked by two agents (two controls rows, same target) is one
    // control root, not a two-owner conflict.
    SECTION("duplicate invoked node collapses to one root") {
        Conn conns = {{7, 1, "text"}, {1, 2, "text"}};
        std::vector<int> invoked = {7, 7};
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_NO_ERROR(regions);
        REQUIRE(regions->control.size() == 1);
        REQUIRE(regions->control[0].second == std::vector<int>{1, 2});
    }

    // Nested invoke chain: agent1 (head, node 1) invokes tool_pipe 7, whose
    // sub-pipeline holds agent2 (node 2) that invokes tool_pipe 8, whose
    // sub-pipeline holds agent3 (node 3) that invokes tool_pipe 9 (node 4 is its
    // leaf). Modeled as data edges SRC->1, 7->2, 8->3, 9->4 plus the three
    // invoked tool_pipes. Each tool_pipe is control-invoked (never data-fed), so
    // none trips the data-fed guard; the partitioner sees a flat set of roots,
    // so arbitrary nesting depth just yields one disjoint region per tool_pipe.
    // (Distinct tool_pipe per level -> distinct instances at runtime; only the
    // SAME node re-invoked within its own subtree would need per-invocation
    // instance isolation, which is out of scope here.)
    SECTION("nested invoke chain: each tool_pipe owns a disjoint region") {
        Conn conns = {{SRC, 1, "questions"}, {7, 2, "questions"},
                      {8, 3, "questions"}, {9, 4, "questions"}};
        std::vector<int> invoked = {7, 8, 9};
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_NO_ERROR(regions);
        REQUIRE(regions->head == std::vector<int>{1});
        REQUIRE(regions->control.size() == 3);
        REQUIRE(regions->control[0] == std::pair<int, std::vector<int>>{7, {2}});
        REQUIRE(regions->control[1] == std::pair<int, std::vector<int>>{8, {3}});
        REQUIRE(regions->control[2] == std::pair<int, std::vector<int>>{9, {4}});
    }

    // Multi-start topologies where a SECOND source chain interacts with a
    // control node's sub-pipeline. Node ids: A=1 B=2 C=3 D=4 E=5, tool_pipe=9,
    // F=6 G=7 H=8, K=11 L=12 M=13. A control node's sub-pipeline must be
    // exclusively its own; sharing it with the main flow (or a second start) is
    // rejected, since the shared node would flush with the head, not during the
    // invocation, leaving the tool an incomplete result.

    // Pipeline #1: A->B->C->D->E, C invokes tool_pipe 9 -> F -> G -> H, and a
    // second start K->L->M DATA-feeds F (M->F). tool_pipe reaches F, which the
    // main flow now owns (source-reachable via M) -> rejected.
    SECTION("reject: second start data-feeds the tool_pipe sub-pipe head") {
        Conn conns = {{SRC, 1, "t"},  {1, 2, "t"},   {2, 3, "t"},  {3, 4, "t"},
                      {4, 5, "t"},    {9, 6, "t"},    {6, 7, "t"},  {7, 8, "t"},
                      {SRC, 11, "t"}, {11, 12, "t"}, {12, 13, "t"}, {13, 6, "t"}};
        std::vector<int> invoked = {9};
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_ERROR(regions, Ec::InvalidParam, "must not be shared with the main");
    }

    // Pipeline #2: as #1 but the second start feeds a MIDDLE node (M->G).
    // tool_pipe drives F, but F reaches G which the main flow owns -> rejected.
    SECTION("reject: second start data-feeds a middle tool_pipe sub-pipe node") {
        Conn conns = {{SRC, 1, "t"},  {1, 2, "t"},   {2, 3, "t"},  {3, 4, "t"},
                      {4, 5, "t"},    {9, 6, "t"},    {6, 7, "t"},  {7, 8, "t"},
                      {SRC, 11, "t"}, {11, 12, "t"}, {12, 13, "t"}, {13, 7, "t"}};
        std::vector<int> invoked = {9};
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_ERROR(regions, Ec::InvalidParam, "must not be shared with the main");
    }

    // Pipeline #4: A->B->C->D->E; C invokes tool_pipe 9 -> F -> D, so the
    // sub-pipeline merges back into the main-flow node D (source-reachable via
    // C->D). tool_pipe reaches a head-owned node -> rejected.
    SECTION("reject: tool_pipe sub-pipeline intersects the main pipeline") {
        Conn conns = {{SRC, 1, "t"}, {1, 2, "t"}, {2, 3, "t"}, {3, 4, "t"},
                      {4, 5, "t"},   {9, 6, "t"}, {6, 4, "t"}};
        std::vector<int> invoked = {9};
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_ERROR(regions, Ec::InvalidParam, "must not be shared with the main");
    }

    // Pipeline #3: A->B->C->D->E with C invoking tool_pipe 9 (-> F -> G -> H), and
    // a second start K->L->M whose L ALSO invokes the SAME tool_pipe 9. Two
    // invokers, one invoked node -> one region (the invoked node dedups). The
    // sub-pipeline is exclusively tool_pipe's; each invocation drives it in turn.
    // ALLOWED (nothing shared with the main flow).
    SECTION("allow: same tool_pipe invoked from two starts collapses to one region") {
        Conn conns = {{SRC, 1, "t"},  {1, 2, "t"},   {2, 3, "t"}, {3, 4, "t"},
                      {4, 5, "t"},    {9, 6, "t"},    {6, 7, "t"}, {7, 8, "t"},
                      {SRC, 11, "t"}, {11, 12, "t"}, {12, 13, "t"}};
        std::vector<int> invoked = {9, 9};  // invoked by C (3) and L (12)
        auto regions = engine::store::computeLifecycleRegions(conns, invoked);
        REQUIRE_NO_ERROR(regions);
        REQUIRE(regions->head.size() == 8);
        REQUIRE(regions->control.size() == 1);
        REQUIRE(regions->control[0] == std::pair<int, std::vector<int>>{9, {6, 7, 8}});
    }
}
