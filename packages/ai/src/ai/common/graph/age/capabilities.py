# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Dialect capability table — the rewrite framework, keyed by AGE version.

Apache AGE speaks a Cypher subset with version-specific gaps. Each capability
cell records how a given AGE version handles one feature:

- ``SUPPORTED``: passes through untouched.
- ``EMULATE``: a rewrite hook transforms the query into something AGE runs
  with the same meaning; the rewritten text is re-analyzed before later stages.
- ``REJECT``: raise :class:`~.errors.AgeUnsupportedFeature` before touching
  the database, with an actionable message.
- ``TBD``: not yet verified against the live version. TBD cells pass through
  — if AGE cannot run the construct, its own error surfaces via EXPLAIN or
  execution (which the LLM repair loop consumes). Verify each TBD cell
  against the live instance and promote it to a real status.

Cells marked verified below were confirmed empirically against a container on
the live pin (PG16 + AGE 1.5.0); see the layer README.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Callable, Dict, Optional

from .analysis import CypherFacts
from .errors import AgeUnsupportedFeature


class CellStatus(enum.Enum):
    SUPPORTED = 'supported'
    EMULATE = 'emulate'
    REJECT = 'reject'
    TBD = 'tbd'


@dataclass(frozen=True)
class Capability:
    """One feature cell for one AGE version."""

    feature: str
    status: CellStatus
    # Predicate: does this query use the feature?
    detect: Callable[[CypherFacts], bool]
    # Message detail for REJECT; verification note otherwise.
    detail: str = ''
    # EMULATE hook: CypherFacts -> rewritten Cypher text.
    rewrite: Optional[Callable[[CypherFacts], str]] = None


def _uses_function(name: str) -> Callable[[CypherFacts], bool]:
    return lambda facts: name in facts.function_names


def _rewrite_empty_in(facts: CypherFacts) -> str:
    """Replace every ``<expr> IN []`` with ``false``.

    openCypher defines ``x IN []`` as false for every ``x``, null included, so
    the substitution keeps the query's meaning. A span inside another one
    (``(x IN []) IN []``) disappears with the outer replacement, so only
    outermost spans are spliced — last-first, so earlier offsets stay valid.
    """
    spans = facts.empty_in_spans
    outermost = [s for s in spans if not any(o != s and o[0] <= s[0] and s[1] <= o[1] for o in spans)]
    text = facts.query
    for start, stop in sorted(outermost, reverse=True):
        text = text[:start] + 'false' + text[stop + 1 :]
    return text


# ---------------------------------------------------------------------------
# AGE 1.5.0 — what the RocketRide cloud runs
# ---------------------------------------------------------------------------

AGE_1_5_0: Dict[str, Capability] = {
    cap.feature: cap
    for cap in (
        # --- verified against the live pin (see README / age-mechanics probes) ---
        Capability(
            feature='datetime_function',
            status=CellStatus.REJECT,
            detect=_uses_function('datetime'),
            detail=(
                'AGE 1.5.0 has no datetime() (function ag_catalog.age_datetime does not exist); '
                'store timestamps as ISO-8601 strings or epoch numbers instead'
            ),
        ),
        Capability(
            feature='return_star',
            status=CellStatus.REJECT,
            detect=lambda facts: facts.returns_star,
            detail=(
                "AGE requires an explicit result-column list and 'RETURN *' needs full scope "
                'analysis to synthesize one; list the columns explicitly (e.g. RETURN a, b)'
            ),
        ),
        Capability(
            feature='order_by_alias',
            status=CellStatus.REJECT,
            detect=lambda facts: facts.has_order_by_alias,
            detail=(
                "AGE 1.5.0 cannot ORDER BY a projection alias ('could not find rte for <name>'); "
                'order by the expression itself (e.g. ORDER BY r.since, not ORDER BY since)'
            ),
        ),
        # --- verified 2026-07-28 against the exact pin container (PG 16.14 +
        # AGE 1.5.0): all four are syntax-level rejections ('syntax error at or
        # near ...'), while plain MERGE on the same graph succeeds — so these
        # are real 1.5.0 grammar gaps, not harness artifacts. ---
        Capability(
            feature='merge_on_set',
            status=CellStatus.REJECT,
            detect=lambda facts: facts.has_merge_action,
            detail=(
                "AGE 1.5.0 does not parse MERGE ... ON CREATE/ON MATCH SET (syntax error at 'ON'); "
                'use plain MERGE, then a separate SET clause (MERGE (n) ... SET n.prop = ...)'
            ),
        ),
        Capability(
            feature='where_label_check',
            status=CellStatus.REJECT,
            detect=lambda facts: facts.has_where_label_check,
            detail=(
                "AGE 1.5.0 does not parse label predicates in WHERE — 'WHERE n:Label' and "
                "'WHERE (n:Label)' both fail (syntax error at ':'); put the label in the "
                'pattern instead (MATCH (n:Label))'
            ),
        ),
        Capability(
            feature='multi_label',
            status=CellStatus.REJECT,
            detect=lambda facts: facts.has_multi_label,
            detail=(
                'AGE 1.5.0 does not parse multiple labels on one node — (n:A:B) fails in both '
                "CREATE and MATCH (syntax error at ':'); model the second label as a property "
                'or an edge to a category node'
            ),
        ),
        # --- verified 2026-10-02 / 2026-10-05 / 2026-10-06 against the
        # datacore image (PG 16.15 + AGE 1.5.0): both shapes report success
        # while storing or returning the wrong data. SET/REMOVE/DELETE reach
        # only the first entity a MERGE creates in a statement: later UNWIND /
        # MATCH rows, a second MERGE, the far node and the edge of a path MERGE,
        # and repeated SETs on a created node all lose the change; entities a
        # MERGE matched and variables bound before it keep it. ---
        Capability(
            feature='merge_write',
            status=CellStatus.REJECT,
            detect=lambda facts: facts.has_unsafe_write_after_merge,
            detail=(
                'AGE 1.5.0 applies SET/REMOVE/DELETE only to the first entity a MERGE creates '
                'in a statement; changes to anything else it creates (later rows, a second '
                'MERGE, a path MERGE) are dropped while the RETURN shows them. After a MERGE, '
                'change only variables bound before it, or the node of a single-node MERGE '
                'that starts the query. Run the MERGE, then the SET/REMOVE/DELETE as a separate '
                'execute call (UNWIND $rows AS row MATCH (n:L {key: row.key}) SET n.prop = row.prop). '
                'Properties inside the MERGE pattern are stored, but MERGE matches on them, so '
                'with other values it creates a second node or edge'
            ),
        ),
        Capability(
            feature='empty_list_in',
            status=CellStatus.EMULATE,
            detect=lambda facts: bool(facts.empty_in_spans),
            detail=(
                "AGE 1.5.0 evaluates 'x IN []' as true for every row, and fails with 'cache lookup "
                "failed for type 0' under NOT / AND / RETURN; rewritten to 'false', its openCypher "
                'value. An empty list passed as a $parameter is evaluated correctly.'
            ),
            rewrite=_rewrite_empty_in,
        ),
        Capability(
            feature='shortest_path',
            status=CellStatus.REJECT,
            detect=_uses_function('shortestpath'),
            detail=(
                'AGE 1.5.0 has no shortestPath() (syntax error); use a bounded variable-length '
                'match (e.g. (a)-[*..3]-(b)) and rank by path length in the query'
            ),
        ),
    )
}

#: Capability tables keyed by AGE version string.
CAPABILITY_TABLES: Dict[str, Dict[str, Capability]] = {
    '1.5.0': AGE_1_5_0,
}

DEFAULT_AGE_VERSION = '1.5.0'


def apply_capabilities(facts: CypherFacts, age_version: str = DEFAULT_AGE_VERSION) -> CypherFacts:
    """Run the dialect gate: REJECT cells raise; EMULATE cells rewrite.

    Unknown versions fall back to the newest known table (closest behaviour
    beats no gate at all). TBD and SUPPORTED cells pass through unchanged.
    """
    table = CAPABILITY_TABLES.get(age_version)
    if table is None:
        table = CAPABILITY_TABLES[sorted(CAPABILITY_TABLES)[-1]]

    for cap in table.values():
        if not cap.detect(facts):
            continue
        if cap.status is CellStatus.REJECT:
            raise AgeUnsupportedFeature(cap.feature, cap.detail)
        if cap.status is CellStatus.EMULATE and cap.rewrite is not None:
            # Re-analyze the rewritten text so later stages see consistent
            # facts, but keep the caller-visible column names of the query
            # as written (a rewrite must not rename result keys).
            from .analysis import analyze

            rewritten = analyze(cap.rewrite(facts))
            # A rewrite may drop the only reference to a $parameter (e.g.
            # '$who IN []' -> 'false'); the caller still supplies it.
            rewritten.param_names = facts.param_names
            if (
                facts.return_columns is not None
                and rewritten.return_columns is not None
                and len(facts.return_columns) == len(rewritten.return_columns)
            ):
                rewritten.return_columns = facts.return_columns
            facts = rewritten
    return facts
