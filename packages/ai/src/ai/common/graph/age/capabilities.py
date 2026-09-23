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
  (framework only in v1 — no emulations are implemented yet).
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
    # EMULATE hook: CypherFacts -> rewritten Cypher text. v1: none implemented.
    rewrite: Optional[Callable[[CypherFacts], str]] = None


def _uses_function(name: str) -> Callable[[CypherFacts], bool]:
    return lambda facts: name in facts.function_names


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
            # v1 ships the framework only; when emulations land they re-analyze
            # the rewritten text so later stages see consistent facts.
            from .analysis import analyze

            facts = analyze(cap.rewrite(facts))
    return facts
