# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .exa_search import ExaSearch


class IGlobal(IGlobalBase):
    search: ExaSearch | None = None

    @staticmethod
    def _get_apikey(cfg: dict, conn_config: dict) -> str:
        apikey = str((cfg.get('apikey') or '')).strip()
        if apikey:
            return apikey
        apikey = str((conn_config.get('apikey') or '')).strip()
        if apikey:
            return apikey
        return str((os.environ.get('ROCKETRIDE_APIKEY_EXA') or '')).strip()

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        apikey = self._get_apikey(cfg, self.glb.connConfig)

        if not apikey:
            raise Exception('search_exa: apikey is required')

        self.search = ExaSearch(self.glb.logicalType, self.glb.connConfig, self.IEndpoint.endpoint.bag)

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = self._get_apikey(cfg, self.glb.connConfig)
            if not apikey:
                warning('apikey is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.search = None
