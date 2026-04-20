# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow_if global state. Holds configuration parsed from services.json."""

from __future__ import annotations

from rocketlib import IGlobalBase, OPEN_MODE


class IGlobal(IGlobalBase):
    # Parsed from the node's configuration (services.*.json `shape`).
    condition: str = 'True'
    timeout_s: float = 5.0

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        profile = getattr(self, 'profile', None) or {}
        self.condition = str(profile.get('condition', self.condition))
        try:
            self.timeout_s = float(profile.get('timeout_s', self.timeout_s))
        except (TypeError, ValueError):
            self.timeout_s = 5.0

    def endGlobal(self) -> None:
        return None
