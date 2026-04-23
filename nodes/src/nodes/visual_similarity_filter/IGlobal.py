# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import threading
from rocketlib import IGlobalBase
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """Global context for the Visual Similarity Filter node.

    Holds the reference image bytes and the generated text description shared
    across all instances.  No ML model is loaded here — inference is delegated
    to a local Ollama server at runtime.

    Architecture: text-first pipeline (validated at 91% accuracy).
      - Reference image is used only once to generate a text description via VLM.
      - Per-frame scoring uses full frame + text query only (no image comparison).
      - YOLO pre-filter skips VLM calls on frames with no vehicles detected.
    """

    config = None  # parsed profile config dict
    ref_bytes = None  # raw bytes of the reference image (image/image-text modes)
    ref_mime = 'image/jpeg'
    ref_ready = None  # threading.Event — set once ref is ready
    ref_description = None  # text description used for all per-frame VLM queries
    device_lock = None  # threading.Lock protecting ref_bytes / ref_description writes

    def beginGlobal(self):
        self.device_lock = threading.Lock()
        self.ref_ready = threading.Event()
        self.config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.config['type'] = self.glb.connConfig.get('profile', 'vlm-image')

    def endGlobal(self):
        self.ref_bytes = None
        self.ref_ready = None
        self.ref_description = None
        self.device_lock = None
        self.config = None
