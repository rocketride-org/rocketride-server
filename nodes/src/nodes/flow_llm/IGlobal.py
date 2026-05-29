# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow.llm global state. Reads question and per-branch targets."""

from __future__ import annotations

from typing import Dict, List

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE


class IGlobal(IGlobalBase):
    """Global state for flow.llm — natural-language question + branches."""

    # `condition` here is a natural-language yes/no question.
    condition: str = 'Does the content match the criterion?'
    branches: Dict[str, List[str]] = {}

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        raw_question = cfg.get('condition', cfg.get('flow_llm.condition'))
        if isinstance(raw_question, str) and raw_question.strip():
            self.condition = raw_question.strip()
        self.branches = _parse_branches(cfg.get('flow_llm.branches', cfg.get('branches')))

    def endGlobal(self) -> None:
        return None


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
