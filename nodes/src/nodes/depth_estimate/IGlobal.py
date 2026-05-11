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

        self.estimator = DepthEstimator(self.glb.logicalType, self.glb.connConfig, bag)
        self.interval = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig).get('interval', 1)
        self.max_video_size_bytes = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig).get('maxVideoSizeMB', 500) * 1024 * 1024
        self.device_lock = threading.Lock()

    def endGlobal(self):
        self.estimator = None
        self.device_lock = None
