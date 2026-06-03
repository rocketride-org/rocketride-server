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
    IInstance handles per-frame detection for the detect node.

    Accepts image lane (AVI stream). Emits per frame:
      - text lane: JSON array of detections [{label, score, box, centroid}].
      - image lane: annotated frame with bounding boxes + labels.
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._chunk_id = 0
        self._image_data = None

    def _annotate(self, image, detections):
        """Draw bounding boxes and labels onto a copy of the image."""
        from PIL import ImageDraw

        annotated = image.copy()
        draw = ImageDraw.Draw(annotated)
        for det in detections:
            b = det['box']
            draw.rectangle([b['x1'], b['y1'], b['x2'], b['y2']], outline='lime', width=2)
            draw.text((b['x1'], b['y1'] - 10), f'{det["label"]} {det["score"]:.2f}', fill='lime')
        return annotated

    def _emit(self, image, detections, chunk_id):
        annotated = self._annotate(image, detections)

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(detections))

        if self.instance.hasListener('image'):
            image_bytes = ImageProcessor.get_bytes(annotated)
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

            with self.IGlobal.device_lock:
                detections = self.IGlobal.detector.detect(image)

            self._emit(image, detections, self._chunk_id)

            self._image_data = None
            self._chunk_id += 1
            return self.preventDefault()
