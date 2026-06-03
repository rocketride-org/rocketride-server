# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import json

from rocketlib import IInstanceBase, AVI_ACTION
from ai.common.image import ImageProcessor
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    IInstance handles background removal for the background_removal node.

    Accepts image lane (AVI stream). Emits per frame:
      - text lane: JSON alpha stats {mean_alpha, alpha_coverage_pct}.
      - image lane: RGBA cutout PNG (straight, non-premultiplied alpha).
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._chunk_id = 0
        self._image_data = None

    def _emit(self, image, chunk_id):
        """Run BG removal on one PIL frame and fan out to all listeners."""
        with self.IGlobal.device_lock:
            rgba_image, stats = self.IGlobal.remover.remove(image)

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(stats))

        if self.instance.hasListener('image'):
            # PNG bytes preserve the alpha channel through the AVI byte-stream
            # abstraction (the container is byte-oriented, not video-codec).
            image_bytes = ImageProcessor.get_bytes(rgba_image)
            self.instance.writeImage(AVI_ACTION.BEGIN, 'image/png')
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/png', image_bytes)
            self.instance.writeImage(AVI_ACTION.END, 'image/png')

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._image_data = bytearray()
        elif action == AVI_ACTION.WRITE:
            self._image_data += buffer
        elif action == AVI_ACTION.END:
            image = ImageProcessor.load_image_from_bytes(self._image_data)
            self._emit(image, self._chunk_id)
            self._image_data = None
            self._chunk_id += 1
            return self.preventDefault()
