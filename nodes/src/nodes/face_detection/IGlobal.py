# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
import threading

from rocketlib import IGlobalBase, OPEN_MODE


class IGlobal(IGlobalBase):
    """
    IGlobal for the Face Detection node.

    Loads MediaPipe BlazeFace once at pipeline start and exposes a device
    lock for thread-safe inference across concurrent IInstance handlers.
    """

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        from .face_detection import FaceDetector

        bag = self.IEndpoint.endpoint.bag

        self.detector = FaceDetector(self.glb.logicalType, self.glb.connConfig, bag)

        self.device_lock = threading.Lock()

    def endGlobal(self):
        detector = getattr(self, 'detector', None)
        if detector is not None:
            try:
                detector.close()
            except Exception:
                pass
        self.detector = None
        self.device_lock = None
