# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow_if_else_llm global state. Reads question, timeout, and per-branch targets."""

from __future__ import annotations

import logging
from typing import Dict, List

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE

_logger = logging.getLogger('rocketride.flow')


class IGlobal(IGlobalBase):
    """Global state for flow_if_else_llm.

    ``branches`` is a map from branch name (``"then"`` / ``"else"``) to the
    list of downstream node IDs on that branch. The canvas populates it
    automatically when the user wires edges out of the branched output
    ports; the Python side just reads the resolved dict.

    Unlike ``flow_if_else``, the condition is a free-form natural-language
    string sent to an LLM verbatim. There is no Python parse or dry-eval
    at load time — the only validation is that the string is non-empty.
    Bad question wording fails at runtime by routing chunks to ELSE; the
    Errors panel shows the LLM's response that didn't parse as YES/NO.
    """

    question: str = 'Does the content match the criterion?'
    timeout_s: float = 30.0
    branches: Dict[str, List[str]] = {}

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        # Bare key first, dotted as fallback — same convention as
        # flow_if_else (UI updates the bare key on edit; preconfig profile
        # writes the dotted form).
        raw_question = cfg.get('question', cfg.get('flow_if_else_llm.question'))
        if isinstance(raw_question, str) and raw_question.strip():
            self.question = raw_question.strip()
        self.timeout_s = _parse_timeout(cfg)
        self.branches = _parse_branches(cfg.get('flow_if_else_llm.branches', cfg.get('branches')))

        # Topology lint — same as flow_if_else.
        then_targets = frozenset(self.branches.get('then', []))
        else_targets = frozenset(self.branches.get('else', []))
        if then_targets and then_targets == else_targets:
            _logger.warning(
                'flow_if_else_llm %s: THEN and ELSE have identical targets %s — LLM decision has no effect on downstream routing',
                _node_id(self),
                sorted(then_targets),
            )

    def endGlobal(self) -> None:
        return None

    def targets_for(self, branch: str) -> List[str]:
        """Return the list of downstream node IDs for the given branch."""
        return list(self.branches.get(branch, []))


def _node_id(ig: 'IGlobal') -> str:
    """Best-effort node identifier for log context."""
    for attr in ('nodeId', 'node_id', 'id'):
        value = getattr(ig.glb, attr, None) if hasattr(ig, 'glb') else None
        if isinstance(value, str) and value:
            return value
    return '<unknown>'


def _parse_timeout(cfg: dict) -> float:
    """Clamp the configured timeout into `[5, 120]` seconds; fall back to 30.0 on invalid input.

    The bound is wider than flow_if_else's because LLM inference is
    inherently slower than sandbox eval and rate-limited by upstream
    providers.
    """
    raw = cfg.get('flow_if_else_llm.timeout_s', cfg.get('timeout_s'))
    if raw is None:
        return 30.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 30.0
    return max(5.0, min(value, 120.0))


def _parse_branches(raw: object) -> Dict[str, List[str]]:
    """Normalise the branches map. Same logic as flow_if_else._parse_branches."""
    result: Dict[str, List[str]] = {'then': [], 'else': []}
    if raw is None or not hasattr(raw, 'items'):
        return result
    for branch, targets in raw.items():
        if not isinstance(branch, str):
            continue
        if isinstance(targets, (str, bytes)) or not hasattr(targets, '__iter__'):
            continue
        result[branch] = [t for t in targets if isinstance(t, str) and t]
    return result
