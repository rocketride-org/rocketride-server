# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow.pyeval global state. Reads condition, timeout, and per-branch targets."""

from __future__ import annotations

import logging
from typing import Dict, List

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE

_logger = logging.getLogger('rocketride.flow')


class IGlobal(IGlobalBase):
    """Global state for flow.pyeval."""

    condition: str = 'True'
    timeout_s: float = 5.0
    branches: Dict[str, List[str]] = {}

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        # Bare key first, dotted as fallback. UI updates the bare key on
        # edit; preconfig profile writes the dotted form.
        raw_condition = cfg.get('condition', cfg.get('flow_pyeval.condition'))
        if isinstance(raw_condition, str) and raw_condition.strip():
            self.condition = raw_condition.strip()
        self.timeout_s = _parse_timeout(cfg)
        self.branches = _parse_branches(cfg.get('flow_pyeval.branches', cfg.get('branches')))

    def endGlobal(self) -> None:
        return None


def _parse_timeout(cfg: dict) -> float:
    """Clamp timeout into [1, 60]s; default 5.0 on invalid input."""
    raw = cfg.get('flow_pyeval.timeout_s', cfg.get('timeout_s'))
    if raw is None:
        return 5.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 5.0
    return max(1.0, min(value, 60.0))


def _parse_branches(raw: object) -> Dict[str, List[str]]:
    """Normalise the branches map. Handles plain dicts and IJson wrappers."""
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
