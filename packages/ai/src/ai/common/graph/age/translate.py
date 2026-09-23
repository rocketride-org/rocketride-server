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

"""The translation pipeline: Cypher text in, executable SQL plan out.

Stage order (per the design):

1. **Parse** — openCypher ANTLR grammar (:mod:`.analysis`).
2. **Firewall** — resource caps on both paths; semantic read-only rules on
   the safe path only (:mod:`.firewall`).
3. **Dialect** — capability table keyed by AGE version (:mod:`.capabilities`).
4. **Emit** — ``cypher()`` envelope, synthesized column list, bind plan
   (:mod:`.emit`).

Decoding results back to Python is :func:`~.decode.decode_agtype`; row
assembly from the emitted plan is :func:`decode_row` here. The layer is a
pure transform — no database access — so every stage unit-tests offline.
"""

from __future__ import annotations

import enum
from typing import Any, Dict, List, Optional, Sequence

from .analysis import analyze
from .capabilities import DEFAULT_AGE_VERSION, apply_capabilities
from .decode import decode_agtype
from .emit import TranslatedQuery, emit
from .firewall import FirewallConfig, check_pre_parse, check_resource_caps, check_semantics_readonly


class TranslateMode(enum.Enum):
    """Which firewall posture the caller runs under."""

    # The LLM/tool path: semantic read-only rules + resource caps; the node
    # runs the plan in a READ ONLY transaction.
    SAFE = 'safe'
    # The gated EXECUTE path: resource caps still apply, semantics don't.
    RAW = 'raw'


def translate(
    cypher: str,
    params: Optional[Dict[str, Any]] = None,
    limit: Optional[int] = None,
    mode: TranslateMode = TranslateMode.SAFE,
    graph_name: str = 'rocketride',
    age_version: str = DEFAULT_AGE_VERSION,
    firewall: Optional[FirewallConfig] = None,
) -> TranslatedQuery:
    """Translate one Cypher query into an executable AGE SQL plan.

    Raises:
        AgeTranslationError: the text does not parse (or cannot be emitted).
        AgeUnsupportedFeature: a capability cell rejects the construct.
        AgeFirewallRejected: a resource cap or (safe path) semantic rule fires.
    """
    config = firewall or FirewallConfig()

    # Length/nesting caps run BEFORE the parse — the parse is the expensive
    # step they bound, so an oversize query is rejected in O(n) scan time
    # instead of after seconds of ANTLR work.
    check_pre_parse(cypher, config)

    facts = analyze(cypher)

    # Firewall: resource caps guard BOTH paths; only semantics are mode-gated.
    check_resource_caps(facts, config)
    if mode is TranslateMode.SAFE:
        check_semantics_readonly(facts)

    facts = apply_capabilities(facts, age_version)

    return emit(
        facts,
        graph_name=graph_name,
        params=params,
        limit=limit,
        statement_timeout_ms=config.statement_timeout_ms,
        read_only=mode is TranslateMode.SAFE,
    )


def decode_row(plan: TranslatedQuery, raw_row: Sequence[Any]) -> Dict[str, Any]:
    """Decode one raw result row into a dict keyed by Cypher display names."""
    names: List[str] = plan.columns or []
    return {(names[i] if i < len(names) else f'col{i}'): decode_agtype(value) for i, value in enumerate(raw_row)}
