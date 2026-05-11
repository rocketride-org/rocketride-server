# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
import threading
from rocketlib import IGlobalBase, OPEN_MODE


class IGlobal(IGlobalBase):
    """
    IGlobal manages global lifecycle for the describe node.

    Loads Florence-2 once at pipeline start and provides a device lock
    for thread-safe inference.
    """

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        import ai.common.torch  # noqa: F401

        from .describe import Describer

        bag = self.IEndpoint.endpoint.bag

        self.describer = Describer(self.glb.logicalType, self.glb.connConfig, bag)
        self.device_lock = threading.Lock()

    def endGlobal(self):
        self.describer = None
        self.device_lock = None
