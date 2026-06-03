# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import json
from typing import Any, Dict, List

from rocketlib import IInstanceBase, AVI_ACTION
from ai.common.image import ImageProcessor
from .IGlobal import IGlobal
from .pose_estimation import COCO_17_EDGES


class IInstance(IInstanceBase):
    """
    IInstance handles per-frame pose estimation.

    Accepts image lane (AVI stream). Emits per frame:
      - text lane: JSON array of person dicts (box + 17 COCO keypoints).
      - image lane: annotated frame with skeleton + keypoints.
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._chunk_id = 0
        self._image_data = None

    def _annotate(self, image, persons: List[Dict[str, Any]]):
        """
        Draw bbox + skeleton edges + keypoint dots onto a copy of the image.

        Keypoints with score below the IGlobal threshold are skipped, and any
        edge with either endpoint skipped is also dropped.
        """
        from PIL import ImageDraw

        annotated = image.copy()
        draw = ImageDraw.Draw(annotated)
        threshold = self.IGlobal.threshold

        for person in persons:
            b = person['box']
            draw.rectangle(
                [b['x1'], b['y1'], b['x2'], b['y2']],
                outline='lime',
                width=2,
            )

            kpts = person['keypoints']

            for i, j in COCO_17_EDGES:
                if i >= len(kpts) or j >= len(kpts):
                    continue
                a = kpts[i]
                c = kpts[j]
                if a['score'] < threshold or c['score'] < threshold:
                    continue
                draw.line(
                    [(a['x'], a['y']), (c['x'], c['y'])],
                    fill='green',
                    width=2,
                )

            for kp in kpts:
                if kp['score'] < threshold:
                    continue
                x, y = kp['x'], kp['y']
                draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill='cyan', outline='cyan')

        return annotated

    def _emit(self, image, persons: List[Dict[str, Any]], chunk_id: int):
        annotated = self._annotate(image, persons)

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(persons))

        if self.instance.hasListener('image'):
            image_bytes = ImageProcessor.get_bytes(annotated)
            self.instance.writeImage(AVI_ACTION.BEGIN, 'image/png')
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/png', image_bytes)
            self.instance.writeImage(AVI_ACTION.END, 'image/png')

    def _pil_to_bgr(self, pil_image):
        """Convert a PIL RGB image to a contiguous OpenCV-style BGR numpy array."""
        import numpy as np

        rgb = np.asarray(pil_image.convert('RGB'))
        bgr = rgb[:, :, ::-1].copy()
        return bgr

    def _estimate(self, pil_image) -> List[Dict[str, Any]]:
        """Run pose estimation under the global device lock."""
        bgr = self._pil_to_bgr(pil_image)
        with self.IGlobal.device_lock:
            return self.IGlobal.pose_estimator.estimate(bgr)

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._image_data = bytearray()

        elif action == AVI_ACTION.WRITE:
            self._image_data += buffer

        elif action == AVI_ACTION.END:
            image = ImageProcessor.load_image_from_bytes(self._image_data)
            persons = self._estimate(image)
            self._emit(image, persons, self._chunk_id)
            self._image_data = None
            self._chunk_id += 1
            return self.preventDefault()
