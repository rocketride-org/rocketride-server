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
    """Shared runtime state for ``search_exa``.

    Lifecycle:
        - ``validateConfig()`` runs during editor/config validation and should
          emit warnings instead of raising for recoverable user input issues.
        - ``beginGlobal()`` runs when the node is opened for execution and must
          initialize any shared runtime dependencies needed by ``IInstance``.
        - ``endGlobal()`` runs during teardown and must release shared state.

    Failure modes:
        - Missing credentials should raise during ``beginGlobal()`` so the
          pipeline fails early with a node-specific message.
        - Dependency installation or backend construction errors are allowed to
          propagate after being logged as warnings.
    """

    search: ExaSearch | None = None

    @staticmethod
    def _get_apikey(cfg: dict, conn_config: dict) -> str:
        """Resolve the Exa API key from node config, connection config, or env."""
        apikey = str((cfg.get('apikey') or '')).strip()
        if apikey:
            return apikey
        apikey = str((conn_config.get('apikey') or '')).strip()
        if apikey:
            return apikey
        return str((os.environ.get('ROCKETRIDE_APIKEY_EXA') or '')).strip()

    def beginGlobal(self) -> None:
        """Initialize the shared Exa backend for runtime execution.

        This hook is skipped in config-only open mode. In execution mode it:
            1. installs any Python dependencies declared by the node,
            2. validates that credentials are present,
            3. creates the shared ``ExaSearch`` backend instance.

        Raises:
            Exception: If the API key is missing.
            Exception: If dependency setup or backend initialization fails.
        """
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
        """Validate user-visible configuration without starting the backend.

        This hook should warn about invalid or missing settings so the editor
        can surface actionable feedback while keeping configuration responsive.
        """
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = self._get_apikey(cfg, self.glb.connConfig)
            if not apikey:
                warning('apikey is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        """Release shared runtime state for this node instance."""
        self.search = None
