"""Shared runtime state for hackjudge_store: resolves the database DSN."""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE

from ._db import Db, resolve_dsn


class IGlobal(IGlobalBase):
    db = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        dsn = resolve_dsn(cfg, self.glb.connConfig)
        if not dsn:
            raise Exception('hackjudge_store: database_url is required')
        self.db = Db(dsn)

    def validateConfig(self) -> None:
        return

    def endGlobal(self) -> None:
        self.db = None
