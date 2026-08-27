"""Shared runtime state for hackjudge_account: DSN + session TTL."""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE

from ._db import Db, resolve_dsn


class IGlobal(IGlobalBase):
    db = None
    session_ttl_hours = 168

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        dsn = resolve_dsn(cfg, self.glb.connConfig)
        if not dsn:
            raise Exception('hackjudge_account: database_url is required')
        try:
            self.session_ttl_hours = int(cfg.get('session_ttl_hours') or 168)
        except (TypeError, ValueError):
            self.session_ttl_hours = 168
        self.db = Db(dsn)

    def validateConfig(self) -> None:
        return

    def endGlobal(self) -> None:
        self.db = None
