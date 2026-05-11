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
    IGlobal manages global lifecycle for the detect node.

    Loads YOLO-World once at pipeline start. Provides a device lock
    for thread-safe inference across concurrent IInstance handlers.
    """

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        import ai.common.torch  # noqa: F401

        from .detect import Detector

        bag = self.IEndpoint.endpoint.bag
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        self.detector = Detector(self.glb.logicalType, self.glb.connConfig, bag)

        self.interval = config.get('interval', 1)
        self.max_frames = config.get('max_frames', 0)
        self.max_video_size_bytes = config.get('maxVideoSizeMB', 500) * 1024 * 1024
        self.device_lock = threading.Lock()

    def endGlobal(self):
        self.detector = None
        self.device_lock = None
