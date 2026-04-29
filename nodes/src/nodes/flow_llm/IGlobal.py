# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow.llm global state. Reads question, timeout, and per-branch targets."""

from __future__ import annotations

import logging
from typing import Dict, List

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE

_logger = logging.getLogger('rocketride.flow')


class IGlobal(IGlobalBase):
    """Global state for flow.llm — natural-language question + branches."""

    # `condition` here is a natural-language yes/no question.
    condition: str = 'Does the content match the criterion?'
    timeout_s: float = 30.0
    branches: Dict[str, List[str]] = {}

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        raw_question = cfg.get('condition', cfg.get('flow_llm.condition'))
        if isinstance(raw_question, str) and raw_question.strip():
            self.condition = raw_question.strip()
        self.timeout_s = _parse_timeout(cfg)
        self.branches = _parse_branches(cfg.get('flow_llm.branches', cfg.get('branches')))

    def endGlobal(self) -> None:
        return None


def _parse_timeout(cfg: dict) -> float:
    """Clamp timeout into [5, 120]s; default 30.0 on invalid input."""
    raw = cfg.get('flow_llm.timeout_s', cfg.get('timeout_s'))
    if raw is None:
        return 30.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 30.0
    return max(5.0, min(value, 120.0))


def _parse_branches(raw: object) -> Dict[str, List[str]]:
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
