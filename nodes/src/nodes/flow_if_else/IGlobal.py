# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow_if_else global state. Reads condition, timeout, and per-branch targets."""

from __future__ import annotations

from typing import Dict, List

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE


class IGlobal(IGlobalBase):
    """Global state for flow_if_else.

    ``branches`` is a map from branch name (``"then"`` / ``"else"``) to the
    list of downstream node IDs on that branch. The canvas populates it
    automatically when the user wires edges out of the branched output
    ports; the Python side just reads the resolved dict.
    """

    condition: str = 'True'
    timeout_s: float = 5.0
    branches: Dict[str, List[str]] = {}

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        raw_condition = cfg.get('condition')
        if isinstance(raw_condition, str) and raw_condition.strip():
            self.condition = raw_condition
        self.timeout_s = _parse_timeout(cfg)
        self.branches = _parse_branches(cfg.get('branches'))

    def endGlobal(self) -> None:
        return None

    def targets_for(self, branch: str) -> List[str]:
        """Return the list of downstream node IDs for the given branch."""
        return list(self.branches.get(branch, []))


def _parse_timeout(cfg: dict) -> float:
    """Clamp the configured timeout into `[1, 60]` seconds; fall back to 5.0 on invalid input."""
    raw = cfg.get('timeout_s')
    if raw is None:
        return 5.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 5.0
    return max(1.0, min(value, 60.0))


def _parse_branches(raw: object) -> Dict[str, List[str]]:
    """Normalise the branches map: drop non-string/empty entries; default empty lists."""
    result: Dict[str, List[str]] = {'then': [], 'else': []}
    if not isinstance(raw, dict):
        return result
    for branch, targets in raw.items():
        if not isinstance(branch, str) or not isinstance(targets, list):
            continue
        result[branch] = [t for t in targets if isinstance(t, str) and t]
    return result
