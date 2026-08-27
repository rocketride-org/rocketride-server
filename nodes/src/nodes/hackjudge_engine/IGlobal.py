"""Shared runtime state for the hackjudge_engine node.

Imports the vendored, self-contained engine (nodes.hackjudge_engine._engine) and
seeds the GitHub token used for repo fetches. Custom nodes run real Python (not
the tool_python sandbox), so the engine's urllib GitHub fetches work normally.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE

from ._engine import engine, fetch
from ._engine import target as target_mod


class IGlobal(IGlobalBase):
    """Holds the vendored engine modules and the resolved GitHub token."""

    engine = engine
    target_mod = target_mod
    fetch = fetch
    github_token: str = ''

    @staticmethod
    def _get_token(cfg: dict, conn_config: dict) -> str:
        token = str((cfg.get('github_token') or '')).strip()
        if token:
            return token
        token = str((conn_config.get('github_token') or '')).strip()
        if token:
            return token
        return str((os.environ.get('ROCKETRIDE_GITHUB_TOKEN') or '')).strip()

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.github_token = self._get_token(cfg, self.glb.connConfig)
        # engine's lazy `from . import fetch as rb` shares this module, so seeding
        # the module global here covers both the passed-in gh() and engine internals.
        self.fetch.GH_TOKEN = self.github_token or self.fetch.github_token()

    def validateConfig(self) -> None:
        return

    def endGlobal(self) -> None:
        return
