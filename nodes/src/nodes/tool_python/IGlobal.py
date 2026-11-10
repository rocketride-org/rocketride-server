# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Python tool node - global (shared) state.

Reads the resolved config and stores sandbox settings (allowed modules, timeout)
for IInstance tool methods.
"""

from __future__ import annotations

from collections.abc import Mapping

from hosting import is_shared_host
from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """Global state for tool_python."""

    allowed_modules: set[str] | None = None
    timeout: int | None = None

    def beginGlobal(self) -> None:
        # The resolved config: the timeout within 1..1200 when set, None for the
        # sandbox default; allowedModules the stored rows or None when unset
        cfg = self.config
        # Extra modules are not offered on the engine's host (see ai.common.sandbox)
        self.allowed_modules = None if is_shared_host() else _parse_allowed_modules(cfg)
        self.timeout = cfg.timeout

    def endGlobal(self) -> None:
        self.allowed_modules = None
        self.timeout = None


def _parse_allowed_modules(cfg: Mapping) -> set[str] | None:
    """Extract allowed module names from the array config field.

    Returns ``None`` if the field is unset (use sandbox defaults),
    or a ``set`` (possibly empty) if the field is present.
    """
    raw = cfg.get('allowedModules')
    if raw is None:
        return None
    modules: set[str] = set()
    for row in raw:
        if not hasattr(row, 'get'):
            continue
        name = str(row.get('moduleName') or '').strip()
        if name:
            modules.add(name)
    return modules
