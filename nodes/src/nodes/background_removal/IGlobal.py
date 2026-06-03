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
    IGlobal manages global lifecycle for the background_removal node.

    Loads BiRefNet once at pipeline start. Provides a device lock for thread-safe
    inference across concurrent IInstance handlers.

    Singleton model + threading.Lock() pattern mirrors the depth_estimate node
    so that GPU-bound inference is serialized inside a single node instance.
    """

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        import ai.common.torch  # noqa: F401

        from .background_removal import BackgroundRemover

        bag = self.IEndpoint.endpoint.bag

        # Read the node config once; reuse for all derived knobs.
        node_cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Track the active profile so per-frame metadata can record the
        # human-readable profile key rather than the raw HF model name.
        self.profile = str(node_cfg.get('profile', 'birefnet-default'))

        # Inference-shaping knobs. The remover also reads them from config
        # (single source of truth) — stashing them here is useful for
        # diagnostics and future re-init paths.
        try:
            self.max_edge = int(node_cfg.get('maxEdge', 1024))
        except (TypeError, ValueError):
            self.max_edge = 1024

        self.remover = BackgroundRemover(self.glb.logicalType, self.glb.connConfig, bag)

        # Single device lock per node — serializes GPU calls across all
        # IInstance handlers attached to this IGlobal.
        self.device_lock = threading.Lock()

    def endGlobal(self):
        self.remover = None
        self.device_lock = None
