# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
import threading
from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """
    IGlobal manages global lifecycle for the pose_estimation node.

    Loads the rtmlib ``Body`` wrapper (RTMDet-nano + RTMPose) once at pipeline
    start. Provides a device lock for thread-safe inference across concurrent
    IInstance handlers.
    """

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        from .pose_estimation import PoseEstimator

        bag = self.IEndpoint.endpoint.bag
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        self.pose_estimator = PoseEstimator(self.glb.logicalType, self.glb.connConfig, bag)

        self.threshold = float(config.get('threshold', 0.3))
        self.max_persons = int(config.get('max_persons', 20))
        self.device_lock = threading.Lock()

    def endGlobal(self):
        self.pose_estimator = None
        self.device_lock = None
