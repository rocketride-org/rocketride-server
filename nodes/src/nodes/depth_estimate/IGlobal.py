# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
import threading
from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        import ai.common.torch  # noqa: F401

        from .depth_estimate import DepthEstimator

        bag = self.IEndpoint.endpoint.bag

        # Pull node config once; reuse for all derived knobs.
        node_cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Stash max_edge on self for diagnostics; the estimator reads it from
        # config too (single source of truth).
        try:
            self.max_edge = int(node_cfg.get('maxEdge', 1024))
        except (TypeError, ValueError):
            self.max_edge = 1024

        self.estimator = DepthEstimator(self.glb.logicalType, self.glb.connConfig, bag)
        self.device_lock = threading.Lock()

    def endGlobal(self):
        self.estimator = None
        self.device_lock = None
