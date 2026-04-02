# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

"""
Python tool node - global (shared) state.

Reads config and stores sandbox settings (allowed modules, timeout)
for IInstance tool methods.
"""

from __future__ import annotations

from typing import Optional, Set

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE


class IGlobal(IGlobalBase):
    """Global state for tool_python."""

    allowed_modules: Optional[Set[str]] = None
    timeout: Optional[int] = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.allowed_modules = _parse_allowed_modules(cfg)
        self.timeout = _parse_timeout(cfg)

    def endGlobal(self) -> None:
        self.allowed_modules = None
        self.timeout = None


def _parse_timeout(cfg: dict) -> int | None:
    """Extract and validate the execution timeout from config. Returns None to use the sandbox default."""
    raw = cfg.get('timeout')
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return max(1, min(value, 1200))


def _parse_allowed_modules(cfg: dict) -> Set[str] | None:
    """Extract allowed module names from the array config field.

    Returns ``None`` if the field is absent (use sandbox defaults),
    or a ``set`` (possibly empty) if the field is present.
    """
    raw = cfg.get('allowedModules')
    if raw is None:
        return None

    if not isinstance(raw, list):
        import json

        try:
            raw = json.loads(str(raw))
        except (json.JSONDecodeError, TypeError, ValueError):
            return set()

    modules: Set[str] = set()
    for row in raw:
        if not hasattr(row, 'get'):
            continue
        name = str(row.get('moduleName') or '').strip()
        if name:
            modules.add(name)
    return modules
