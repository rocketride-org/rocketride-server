# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Python tool node - global (shared) state.

Holds nothing per control: the sandbox settings (allowed modules, timeout) are
per-call parameters; ``sandbox_limits`` reads them from a call's settings.
"""

from __future__ import annotations

from collections.abc import Mapping

from hosting import is_shared_host
from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """Global state for tool_python: nothing per control (the sandbox limits are the call's)."""


def sandbox_limits(settings: Mapping) -> tuple[set[str] | None, int | None]:
    """
    One call's sandbox limits from its settings.

    Args:
        settings: The call's settings: the timeout within 1..1200 when set (None
            for the sandbox default), allowedModules the stored rows or None.

    Returns:
        The extra allowed modules (None: the sandbox defaults; never offered on a
        shared engine host, see ai.common.sandbox) and the timeout.
    """
    allowed = None if is_shared_host() else _parse_allowed_modules(settings)
    return allowed, settings.get('timeout')


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
