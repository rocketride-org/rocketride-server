# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import threading

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config

# Bounds for the input long-edge: default, and the clamp range applied to maxEdge.
DEFAULT_MAX_EDGE = 1024
MIN_MAX_EDGE = 256
MAX_MAX_EDGE = 4096


class IGlobal(IGlobalBase):
    estimator = None
    device_lock = None
    max_edge = DEFAULT_MAX_EDGE

    def beginGlobal(self):
        """Build the shared DepthEstimator facade and parse the clamped maxEdge config."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from ai.common.models.vision.depth import DepthEstimator, DEFAULT_MODEL

        node_cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # max_edge: bound input resolution so inference cost stays predictable.
        try:
            self.max_edge = int(node_cfg.get('maxEdge', DEFAULT_MAX_EDGE))
        except (TypeError, ValueError):
            self.max_edge = DEFAULT_MAX_EDGE
        self.max_edge = min(MAX_MAX_EDGE, max(MIN_MAX_EDGE, self.max_edge))

        # device=None -> model server when --modelserver is set, else local.
        self.estimator = DepthEstimator(DEFAULT_MODEL, device=None)
        self.device_lock = threading.Lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.estimator is not None:
            self.estimator.disconnect()
        self.estimator = None
        self.device_lock = None
