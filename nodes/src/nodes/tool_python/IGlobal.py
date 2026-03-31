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

Creates a ``PythonDriver`` that exposes a single ``execute`` tool for agent
invocation.
"""

from __future__ import annotations

from typing import Set

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .python_driver import PythonDriver


class IGlobal(IGlobalBase):
    """Global state for tool_python."""

    driver: PythonDriver | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        server_name = str(cfg.get('serverName') or 'python').strip()
        allowed_modules = _parse_allowed_modules(cfg)
        timeout = _parse_timeout(cfg)

        try:
            self.driver = PythonDriver(
                server_name=server_name,
                allowed_modules=allowed_modules,
                timeout=timeout,
            )
        except Exception as e:
            warning(str(e))
            raise

    def endGlobal(self) -> None:
        self.driver = None


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
